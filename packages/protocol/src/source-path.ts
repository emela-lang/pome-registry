// source path（4.7）: `host/path`。`https://` と末尾の `.git` を除いた形。
// v2 以上の major の Pome は末尾に `/vN` を付け、`/vN` を外したものが Pome の場所になる。
// github.com では `github.com/<owner>/<repo>` までがリポジトリで、その後ろがリポジトリの中のディレクトリ。
// ほかの host では、場所の全体がリポジトリ。

import { parseVersion, type Version } from "./version.ts";

const GITHUB = "github.com";

export type SourcePath = string & { readonly __brand: "SourcePath" };

const MAX_LENGTH = 255;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ELEMENT = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
const MAJOR_SUFFIX = /\/v([0-9]+)$/;

export class InvalidSourcePath extends Error {
  constructor(
    readonly input: string,
    readonly reason: string,
  ) {
    super(`invalid source path \`${input}\`: ${reason}`);
  }
}

export function parseSourcePath(input: string): SourcePath {
  if (input.length === 0 || input.length > MAX_LENGTH) {
    throw new InvalidSourcePath(input, `length must be 1..${MAX_LENGTH}`);
  }
  const [host, ...rest] = input.split("/");
  if (host === undefined || !HOST.test(host)) {
    throw new InvalidSourcePath(input, "host must be a lowercase domain name");
  }
  if (rest.length === 0) {
    throw new InvalidSourcePath(input, "path is missing");
  }
  for (const element of rest) {
    if (!ELEMENT.test(element)) {
      throw new InvalidSourcePath(input, `bad path element \`${element}\``);
    }
  }
  if (input.endsWith(".git")) {
    throw new InvalidSourcePath(input, "must not end with `.git`");
  }
  const major = MAJOR_SUFFIX.exec(input)?.[1];
  if (major !== undefined) {
    if (!/^[1-9][0-9]*$/.test(major) || Number(major) < 2) {
      throw new InvalidSourcePath(input, "a major suffix must be `/v2` or above, without leading zeros");
    }
    if (rest.length < 2) throw new InvalidSourcePath(input, "repository path is missing before the major suffix");
  }
  const location = rest.length - (major === undefined ? 0 : 1);
  if (host === GITHUB && location < 2) {
    throw new InvalidSourcePath(input, "a github.com path needs the owner and the repository");
  }
  return input as SourcePath;
}

// 末尾の `/vN` の N。なければ undefined（v0 か v1 の Pome）。
export function majorOf(path: SourcePath): number | undefined {
  const m = MAJOR_SUFFIX.exec(path);
  return m === null ? undefined : Number(m[1]);
}

// Pome の場所。`/vN` を外した形。
export function locationOf(path: SourcePath): string {
  return path.replace(MAJOR_SUFFIX, "");
}

// git で取るリポジトリ。github.com では `github.com/<owner>/<repo>`、ほかの host では場所の全体。
export function repositoryOf(path: SourcePath): string {
  const location = locationOf(path);
  if (sourcePathHost(path) !== GITHUB) return location;
  return location.split("/").slice(0, 3).join("/");
}

// リポジトリの中のディレクトリ（`platform-cloudflare`）。リポジトリの根の Pome なら undefined。
export function directoryOf(path: SourcePath): string | undefined {
  const rest = locationOf(path).slice(repositoryOf(path).length);
  return rest === "" ? undefined : rest.slice(1);
}

// 版の git の tag。ディレクトリの Pome ならディレクトリを前に付ける（`platform-cloudflare/v0.1.0`）。
export function tagOf(path: SourcePath, version: Version): string {
  const dir = directoryOf(path);
  return dir === undefined ? version.raw : `${dir}/${version.raw}`;
}

// リポジトリの tag が、この Pome のどの版か。この Pome の tag でなければ undefined。
export function versionOfTag(path: SourcePath, tag: string): Version | undefined {
  const dir = directoryOf(path);
  let raw = tag;
  if (dir !== undefined) {
    if (!tag.startsWith(`${dir}/`)) return undefined;
    raw = tag.slice(dir.length + 1);
  }
  try {
    const version = parseVersion(raw);
    return isVersionOf(path, version) ? version : undefined;
  } catch {
    return undefined;
  }
}

// その tag がこの Pome の版か。`/vN` があれば major が N、なければ v0 か v1。
export function isVersionOf(path: SourcePath, version: Version): boolean {
  const major = majorOf(path);
  return major === undefined ? version.major <= 1 : version.major === major;
}

export function sourcePathHost(path: SourcePath): string {
  return path.slice(0, path.indexOf("/"));
}

// 大文字を `!` + 小文字にする。
// 大文字小文字を区別しないストレージで、`Foo` と `foo` が衝突しないようにする。
export function escapeSourcePath(path: SourcePath): string {
  return path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

export function unescapeSourcePath(escaped: string): SourcePath {
  if (/[A-Z]/.test(escaped)) {
    throw new InvalidSourcePath(escaped, "escaped path must not contain uppercase");
  }
  const raw = escaped.replace(/!(.?)/g, (_, c: string) => {
    if (!/^[a-z]$/.test(c)) {
      throw new InvalidSourcePath(escaped, "`!` must be followed by a lowercase letter");
    }
    return c.toUpperCase();
  });
  return parseSourcePath(raw);
}
