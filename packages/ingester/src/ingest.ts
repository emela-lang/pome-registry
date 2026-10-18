// 取り込みの本体。(source path, version) を受け、tag の commit が指す tree を読んで検査し、
// info・Pome.toml・アーカイブ・ハッシュを返す。R2 にも sumdb にも書かない（それは proxy の Worker）。
//
// 検査（4.7 の取り込みの条件）:
//   - host が許したものに入っていて、DNS で引いた先が私的なアドレスでない
//   - tag `v<version>` がある。major が source path の `/vN` と合う
//   - シンボリックリンクと submodule を含まず、パスが UTF-8 で正しい形
//   - ファイルの数と大きさが上限の内
//   - 根に Pome.toml があり、[pome].name が source path、[pome].version が tag から `v` を外したもの

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gzip,
  InvalidTreePath,
  type IngestError,
  type IngestErrorCode,
  type IngestMeta,
  limits,
  MANIFEST_FILE,
  manifestHash,
  parseSourcePath,
  isVersionOf,
  parseVersion,
  directoryOf,
  repositoryOf,
  tagOf,
  type SourcePath,
  sourcePathHost,
  type TreeFile,
  treeHash,
  type Version,
  writeTar,
} from "@pome-registry/protocol";
import { parse as parseToml } from "smol-toml";
import { git, GitError, type GitOptions, parseCatFileBatch, parseLsTree } from "./git.ts";

export type IngestOptions = {
  readonly allowedHosts: readonly string[];
  // リポジトリ（source path から `/vN` を外したもの）の URL を作る。テストで file:// に差し替える。
  readonly repositoryUrl: (repository: string) => string;
  // host が私的なアドレスに向いていないか。テストでは検査しない。
  readonly checkHost: (host: string) => Promise<boolean>;
  readonly git: GitOptions;
};

export type IngestSuccess = {
  readonly ok: true;
  readonly meta: IngestMeta;
  readonly archive: Uint8Array;
};

export type IngestFailure = {
  readonly ok: false;
  readonly status: number;
  readonly body: IngestError;
};

export class Rejection extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const STATUS: Record<IngestErrorCode, number> = {
  invalid_request: 400,
  host_not_allowed: 403,
  tag_not_found: 404,
  manifest_missing: 422,
  manifest_invalid: 422,
  manifest_name_mismatch: 422,
  manifest_version_mismatch: 422,
  bad_path: 422,
  symlink: 422,
  submodule: 422,
  too_large: 413,
  fetch_failed: 502,
};

const NOT_FOUND =
  /couldn't find remote ref|repository .*not found|does not appear to be a git repository|could not read Username|authentication failed/i;

export async function ingest(input: unknown, options: IngestOptions): Promise<IngestSuccess | IngestFailure> {
  try {
    const { path, version } = parseInput(input);
    return { ok: true, ...(await fetchVersion(path, version, options)) };
  } catch (e) {
    if (e instanceof Rejection) {
      return { ok: false, status: STATUS[e.code], body: { error: e.code, message: e.message } };
    }
    throw e;
  }
}

function parseInput(input: unknown): { path: SourcePath; version: Version } {
  if (typeof input !== "object" || input === null) throw new Rejection("invalid_request", "body must be an object");
  const { path, version } = input as Record<string, unknown>;
  if (typeof path !== "string" || typeof version !== "string") {
    throw new Rejection("invalid_request", "`path` and `version` must be strings");
  }
  try {
    const parsed = { path: parseSourcePath(path), version: parseVersion(version) };
    if (!isVersionOf(parsed.path, parsed.version)) {
      throw new Rejection("invalid_request", `${version} is not a version of ${path} (the major must match the /vN suffix)`);
    }
    return parsed;
  } catch (e) {
    if (e instanceof Rejection) throw e;
    throw new Rejection("invalid_request", (e as Error).message);
  }
}

async function fetchVersion(
  path: SourcePath,
  version: Version,
  options: IngestOptions,
): Promise<{ meta: IngestMeta; archive: Uint8Array }> {
  const host = sourcePathHost(path);
  if (!options.allowedHosts.includes(host)) {
    throw new Rejection("host_not_allowed", `${host} is not an allowed host`);
  }
  if (!(await options.checkHost(host))) {
    throw new Rejection("host_not_allowed", `${host} resolves to a private address`);
  }

  const dir = await mkdtemp(join(tmpdir(), "pome-ingest-"));
  try {
    const run = (args: readonly string[], stdin?: string) => git(dir, args, options.git, stdin);
    const tag = `refs/tags/${tagOf(path, version)}`;
    await run(["init", "--quiet", "--bare", "."]);
    try {
      await run(["fetch", "--quiet", "--depth=1", "--no-tags", options.repositoryUrl(repositoryOf(path)), `+${tag}:${tag}`]);
    } catch (e) {
      // 無いリポジトリと非公開のリポジトリは、https では認証を求められる形で失敗する。
      if (e instanceof GitError && NOT_FOUND.test(e.stderr)) {
        throw new Rejection("tag_not_found", `${path}: no tag ${version.raw}`);
      }
      throw new Rejection("fetch_failed", `${path}: ${(e as Error).message}`);
    }

    const commit = (await run(["rev-parse", "--verify", `${tag}^{commit}`])).toString().trim();
    const time = (await run(["show", "-s", "--format=%ct", commit])).toString().trim();
    const files = await readTree(run, commit, path);
    const manifestFile = files.find((f) => f.path === MANIFEST_FILE);
    if (manifestFile === undefined) throw new Rejection("manifest_missing", `${path}@${version.raw}: no ${MANIFEST_FILE}`);
    const manifest = checkManifest(manifestFile.content, path, version);

    let tree;
    try {
      tree = await treeHash(files);
    } catch (e) {
      if (e instanceof InvalidTreePath) throw new Rejection("bad_path", e.message);
      throw e;
    }
    const archive = await gzip(writeTar(files));
    const meta: IngestMeta = {
      info: { version: version.raw, commit, time: new Date(Number(time) * 1000).toISOString().replace(/\.000Z$/, "Z") },
      manifest,
      tree,
      manifestHash: await manifestHash(manifestFile.content),
      archiveSha256: await sha256Hex(archive),
      files: files.length,
      bytes: files.reduce((n, f) => n + f.content.length, 0),
    };
    return { meta, archive };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readTree(
  run: (args: readonly string[], stdin?: string) => Promise<Buffer>,
  commit: string,
  path: SourcePath,
): Promise<TreeFile[]> {
  // ディレクトリの Pome は、そのディレクトリの tree（パスはディレクトリからの相対）。
  const dir = directoryOf(path);
  let entries;
  try {
    entries = parseLsTree(await run(["ls-tree", "-r", "-l", "-z", dir === undefined ? commit : `${commit}:${dir}`]));
  } catch (e) {
    if (e instanceof TypeError) throw new Rejection("bad_path", `${path}: a path is not UTF-8`);
    if (e instanceof GitError && dir !== undefined) {
      throw new Rejection("tag_not_found", `${path}: no directory \`${dir}\` at the tag`);
    }
    throw e;
  }
  let total = 0;
  for (const e of entries) {
    if (e.mode === "120000") throw new Rejection("symlink", `${e.path} is a symbolic link`);
    if (e.type === "commit") throw new Rejection("submodule", `${e.path} is a submodule`);
    if (e.type !== "blob") throw new Rejection("bad_path", `${e.path} has an unexpected type ${e.type}`);
    total += e.size ?? 0;
  }
  if (entries.length > limits.maxFiles) {
    throw new Rejection("too_large", `${entries.length} files (at most ${limits.maxFiles})`);
  }
  if (total > limits.maxTreeBytes) {
    throw new Rejection("too_large", `${total} bytes (at most ${limits.maxTreeBytes})`);
  }
  const blobs = parseCatFileBatch(
    await run(["cat-file", "--batch"], entries.map((e) => `${e.object}\n`).join("")),
    entries.length,
  );
  return entries.map((e, i) => ({ path: e.path, content: new Uint8Array(blobs[i]!) }));
}

function checkManifest(content: Uint8Array, path: SourcePath, version: Version): string {
  if (content.length > limits.maxManifestBytes) {
    throw new Rejection("too_large", `${MANIFEST_FILE} is ${content.length} bytes (at most ${limits.maxManifestBytes})`);
  }
  let text: string;
  let pome: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    pome = (parseToml(text) as Record<string, unknown>).pome;
  } catch (e) {
    throw new Rejection("manifest_invalid", `${MANIFEST_FILE}: ${(e as Error).message}`);
  }
  if (typeof pome !== "object" || pome === null) throw new Rejection("manifest_invalid", `${MANIFEST_FILE}: no [pome]`);
  const { name, version: declared } = pome as Record<string, unknown>;
  if (name !== path) {
    throw new Rejection("manifest_name_mismatch", `[pome].name is ${JSON.stringify(name)}, expected "${path}"`);
  }
  if (declared !== version.raw.slice(1)) {
    throw new Rejection(
      "manifest_version_mismatch",
      `[pome].version is ${JSON.stringify(declared)}, but the tag is ${version.raw}`,
    );
  }
  return text;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
