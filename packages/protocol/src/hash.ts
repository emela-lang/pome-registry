// 中身のハッシュ `h1:`。
//
//   summary = 各ファイルについて `<sha256 の16進>  <path>\n` を、path の UTF-8 のバイト順に並べたもの
//   h1      = "h1:" + base64(sha256(summary))
//
// 入力は commit が指す git の tree から読んだファイルで、作業ツリーではない。
// `.gitattributes` の変換や export-ignore を受けないので、誰がどこで計算しても同じになる。
// シンボリックリンクと submodule は呼ぶ側で拒否し、ここには渡さない。実行ビットは数えない。

export type TreeFile = {
  readonly path: string;
  readonly content: Uint8Array;
};

export type Hash = `h1:${string}`;

export const MANIFEST_FILE = "Pome.toml";

export class InvalidTreePath extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`invalid path \`${path}\` in tree: ${reason}`);
  }
}

const encoder = new TextEncoder();

export async function treeHash(files: readonly TreeFile[]): Promise<Hash> {
  const entries = files.map((f) => {
    checkTreePath(f.path);
    return { path: f.path, key: encoder.encode(f.path), content: f.content };
  });
  entries.sort((a, b) => compareBytes(a.key, b.key));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1]!.path === entries[i]!.path) {
      throw new InvalidTreePath(entries[i]!.path, "duplicate path");
    }
  }
  let summary = "";
  for (const e of entries) {
    summary += `${toHex(await sha256(e.content))}  ${e.path}\n`;
  }
  return `h1:${toBase64(await sha256(encoder.encode(summary)))}`;
}

// `@v/<version>.toml` と sumdb の `/Pome.toml` の行に使う。
export function manifestHash(content: Uint8Array): Promise<Hash> {
  return treeHash([{ path: MANIFEST_FILE, content }]);
}

export function isHash(s: string): s is Hash {
  return /^h1:[A-Za-z0-9+/]{43}=$/.test(s);
}

function checkTreePath(path: string): void {
  if (path.length === 0) throw new InvalidTreePath(path, "empty");
  if (path.includes("\n") || path.includes("\r")) {
    throw new InvalidTreePath(path, "contains a newline");
  }
  if (path.includes("\\")) throw new InvalidTreePath(path, "contains a backslash");
  for (const element of path.split("/")) {
    if (element === "" || element === "." || element === "..") {
      throw new InvalidTreePath(path, "must be a clean relative path");
    }
  }
  if (path === ".git" || path.startsWith(".git/")) {
    throw new InvalidTreePath(path, "`.git` is not part of the tree");
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
