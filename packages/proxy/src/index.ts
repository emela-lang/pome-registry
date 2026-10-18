// proxy の口（4.7 の表）。
//
//   <p>/@v/list                 Git の今の tag（短い間だけキャッシュする）
//   <p>/@latest                 prerelease でない最大の版の .info
//   <p>/@v/<version>.info       R2 から。なければ取り込む
//   <p>/@v/<version>.toml       同上
//   <p>/@v/<version>.tar.gz     同上

import {
  defaultAllowedHosts,
  isVersionOf,
  latestCandidates,
  parseVersion,
  proxyPaths,
  type SourcePath,
  sourcePathHost,
  unescapeSourcePath,
  type Version,
} from "@pome-registry/protocol";
import { listVersions, RepositoryNotFound } from "./git.ts";
import { ingest } from "./ingest.ts";

const LIST_TTL_SECONDS = 60;
// `@latest` で試す版の数。取り込めない版が続いても、ingester をこれより多くは呼ばない。
const LATEST_ATTEMPTS = 5;

export type Route =
  | { readonly kind: "list"; readonly path: SourcePath }
  | { readonly kind: "latest"; readonly path: SourcePath }
  | { readonly kind: "file"; readonly path: SourcePath; readonly version: Version; readonly file: "info" | "toml" | "tar.gz" };

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const route = parseRoute(new URL(request.url).pathname.slice(1));
    if (route === undefined) return text(404, "not found");
    if (!defaultAllowedHosts.includes(sourcePathHost(route.path))) {
      return text(404, `${route.path}: host is not served by this proxy`);
    }

    const res = await serve(env, route);
    return request.method === "HEAD" ? new Response(null, res) : res;
  },
} satisfies ExportedHandler<Env>;

async function serve(env: Env, route: Route): Promise<Response> {
  switch (route.kind) {
    case "list": {
      const versions = await versionsOf(route.path);
      if (versions === undefined) return text(404, `${route.path}: repository not found`);
      return new Response(versions.map((v) => `${v}\n`).join(""), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": `public, max-age=${LIST_TTL_SECONDS}` },
      });
    }
    case "latest": {
      const versions = await versionsOf(route.path);
      if (versions === undefined) return text(404, `${route.path}: repository not found`);
      const candidates = latestCandidates(versions.map(parseVersion));
      if (candidates.length === 0) return text(404, `${route.path}: no version tags`);
      // 取り込めない版（404、410）は飛ばす。取得の一時的な失敗（502）では止める。
      // 飛ばすと古い版を最新と取り違えるため。
      for (const version of candidates.slice(0, LATEST_ATTEMPTS)) {
        const res = await file(env, route.path, version, "info");
        if (res.ok) {
          return new Response(res.body, {
            headers: { "content-type": "application/json", "cache-control": `public, max-age=${LIST_TTL_SECONDS}` },
          });
        }
        if (res.status !== 404 && res.status !== 410) return res;
      }
      return text(404, `${route.path}: none of the latest ${LATEST_ATTEMPTS} versions can be served`);
    }
    case "file":
      if (!isVersionOf(route.path, route.version)) {
        return text(404, `${route.path}: ${route.version.raw} is not a version of this Pome (the major must match the /vN suffix)`);
      }
      return file(env, route.path, route.version, route.file);
  }
}

async function file(env: Env, path: SourcePath, version: Version, kind: "info" | "toml" | "tar.gz"): Promise<Response> {
  const key =
    kind === "info"
      ? proxyPaths.info(path, version)
      : kind === "toml"
        ? proxyPaths.manifest(path, version)
        : proxyPaths.archive(path, version);

  let object = await env.PROXY.get(key);
  if (object === null) {
    // `.info` は最後に置くので、`.info` がなければ取り込みが終わっていない。
    if ((await env.PROXY.head(proxyPaths.info(path, version))) === null) {
      const outcome = await ingest(env, path, version);
      if (!outcome.ok) return text(outcome.status, outcome.message);
    }
    object = await env.PROXY.get(key);
    if (object === null) return text(502, `${path}@${version.raw}: stored object is missing`);
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

// Git の今の tag。リポジトリがなければ undefined。Cache API に短い間だけ置く。
async function versionsOf(path: SourcePath): Promise<string[] | undefined> {
  const cacheKey = new Request(`https://list.invalid/${proxyPaths.list(path)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) return cached.status === 404 ? undefined : (await cached.text()).split("\n").filter(Boolean);

  let versions: string[] | undefined;
  try {
    versions = await listVersions(path);
  } catch (e) {
    if (!(e instanceof RepositoryNotFound)) throw e;
  }
  await caches.default.put(
    cacheKey,
    new Response(versions?.join("\n") ?? "", {
      status: versions === undefined ? 404 : 200,
      headers: { "cache-control": `max-age=${LIST_TTL_SECONDS}` },
    }),
  );
  return versions;
}

export function parseRoute(pathname: string): Route | undefined {
  try {
    if (pathname.endsWith("/@latest")) {
      return { kind: "latest", path: unescapeSourcePath(pathname.slice(0, -"/@latest".length)) };
    }
    const at = pathname.lastIndexOf("/@v/");
    if (at < 0) return undefined;
    const path = unescapeSourcePath(pathname.slice(0, at));
    const name = pathname.slice(at + "/@v/".length);
    if (name === "list") return { kind: "list", path };
    const m = /^(.+)\.(info|toml|tar\.gz)$/.exec(name);
    if (m === null) return undefined;
    return { kind: "file", path, version: parseVersion(m[1]!), file: m[2] as "info" | "toml" | "tar.gz" };
  } catch {
    // source path か version の形が違う。
    return undefined;
  }
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
