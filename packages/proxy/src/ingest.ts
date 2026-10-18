// R2 にない版を取り込む。
//
//   1. ingester に (source path, version) を渡し、info・Pome.toml・アーカイブ・ハッシュを受け取る
//   2. アーカイブを展開して `h1:` を計算し直し、ingester の言う値と照らす
//   3. sumdb の Log に記録する（同じ版に別の中身の記録があれば取り込まない）
//   4. R2 に置く。`.info` を最後に置き、`.info` があれば全部そろっているとみなす
//
// ingester は資格情報を持たず、ここで中身を確かめ直すので、ingester が誤った値を返しても
// sumdb と R2 に食い違った中身は入らない。

import {
  formatRecord,
  gunzip,
  INGEST_PART_ARCHIVE,
  INGEST_PART_META,
  INGEST_PATH,
  type IngestError,
  type IngestErrorCode,
  type IngestMeta,
  importSigningKey,
  limits,
  MANIFEST_FILE,
  manifestHash,
  proxyPaths,
  readTar,
  signRequest,
  type SourcePath,
  SUMDB_LOG_NAME,
  type SumdbLog,
  treeHash,
  type Version,
} from "@pome-registry/protocol";

export type IngestOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 404 | 410 | 502; readonly message: string };

// 取り込めなかった版は短い間覚え、同じ失敗で ingester を叩かせない。
const FAILURE_TTL_SECONDS = 600;

const NOT_FOUND: readonly IngestErrorCode[] = ["host_not_allowed", "invalid_request", "tag_not_found"];

export async function ingest(env: Env, path: SourcePath, version: Version): Promise<IngestOutcome> {
  const failureKey = new Request(`https://failures.invalid/${proxyPaths.info(path, version)}`);
  const cached = await caches.default.match(failureKey);
  if (cached !== undefined) {
    return { ok: false, status: cached.status as 404 | 410, message: await cached.text() };
  }

  const outcome = await fetchAndStore(env, path, version);
  if (!outcome.ok && outcome.status !== 502) {
    await caches.default.put(
      failureKey,
      new Response(outcome.message, {
        status: outcome.status,
        headers: { "cache-control": `max-age=${FAILURE_TTL_SECONDS}` },
      }),
    );
  }
  return outcome;
}

async function fetchAndStore(env: Env, path: SourcePath, version: Version): Promise<IngestOutcome> {
  const body = new TextEncoder().encode(JSON.stringify({ path, version: version.raw }));
  const key = await importSigningKey(env.INGEST_SECRET);
  const res = await env.INGESTER.fetch(`http://ingester${INGEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await signRequest(key, "POST", INGEST_PATH, body)) },
    body,
  });

  if (res.status >= 400 && res.status < 500) {
    const error = (await res.json().catch(() => undefined)) as IngestError | undefined;
    if (error?.error === undefined) return bad(`ingester answered ${res.status}`);
    const status = NOT_FOUND.includes(error.error) ? 404 : 410;
    return { ok: false, status, message: `${path}@${version.raw}: ${error.message}` };
  }
  if (!res.ok) return bad(`ingester answered ${res.status}`);

  const form = await res.formData();
  const metaPart = form.get(INGEST_PART_META);
  const archivePart = form.get(INGEST_PART_ARCHIVE);
  if (typeof metaPart !== "string" || archivePart === null || typeof archivePart === "string") {
    return bad("ingester answered without meta or archive");
  }
  const meta = JSON.parse(metaPart) as IngestMeta;
  const archive = new Uint8Array(await archivePart.arrayBuffer());

  const problem = await verify(meta, archive, version);
  if (problem !== undefined) return bad(`ingester answered inconsistent data: ${problem}`);

  // LOG は別の Worker（pome-sumdb）の Durable Object なので、型は protocol の SumdbLog で受ける。
  const log = env.LOG.getByName(SUMDB_LOG_NAME) as unknown as SumdbLog;
  const result = await log.append(
    formatRecord({ path, version, tree: meta.tree, manifest: meta.manifestHash }),
  );
  if (!result.ok) {
    if (result.error === "conflict") {
      return {
        ok: false,
        status: 410,
        message: `${path}@${version.raw}: the content differs from what the checksum database recorded (was the tag moved?)`,
      };
    }
    return bad(result.message);
  }

  const immutable = "public, max-age=31536000, immutable";
  await Promise.all([
    env.PROXY.put(proxyPaths.archive(path, version), archive, {
      httpMetadata: { contentType: "application/gzip", cacheControl: immutable },
    }),
    env.PROXY.put(proxyPaths.manifest(path, version), meta.manifest, {
      httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: immutable },
    }),
  ]);
  await env.PROXY.put(proxyPaths.info(path, version), JSON.stringify(meta.info), {
    httpMetadata: { contentType: "application/json", cacheControl: immutable },
  });
  return { ok: true };
}

// ingester の答えが自分自身と食い違っていないか。食い違いの説明を返す。
async function verify(meta: IngestMeta, archive: Uint8Array, version: Version): Promise<string | undefined> {
  if (meta.info.version !== version.raw) return `version ${meta.info.version}`;
  if (!/^[0-9a-f]{40}$/.test(meta.info.commit)) return "commit";
  if (archive.length > limits.maxTreeBytes) return "archive too large";
  if ((await sha256Hex(archive)) !== meta.archiveSha256) return "archive sha256";

  // tar のヘッダと埋め草の分（1ファイルあたり最大で約 2 KiB）だけ、展開した大きさは中身の合計より大きい。
  const files = readTar(await gunzip(archive, limits.maxTreeBytes + limits.maxFiles * 2048 + 1024));
  if (files.length > limits.maxFiles || files.length !== meta.files) return "file count";
  if (files.reduce((n, f) => n + f.content.length, 0) !== meta.bytes) return "total size";
  if ((await treeHash(files)) !== meta.tree) return "tree hash";

  const manifest = files.find((f) => f.path === MANIFEST_FILE);
  if (manifest === undefined) return "no Pome.toml";
  if (new TextDecoder().decode(manifest.content) !== meta.manifest) return "Pome.toml";
  if ((await manifestHash(manifest.content)) !== meta.manifestHash) return "Pome.toml hash";
  return undefined;
}

function bad(message: string): IngestOutcome {
  return { ok: false, status: 502, message };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
