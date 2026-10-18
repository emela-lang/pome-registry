// source path（4.7）: `host/path`。`https://` と末尾の `.git` を除いた形。

export type SourcePath = string & { readonly __brand: "SourcePath" };

const MAX_LENGTH = 255;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ELEMENT = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

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
  return input as SourcePath;
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
