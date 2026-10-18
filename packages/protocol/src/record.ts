// sumdb の記録。1つの (source path, version) につき2行。
//
//   github.com/emela-lang/quince v0.3.2 h1:...
//   github.com/emela-lang/quince v0.3.2/Pome.toml h1:...
//
// 2行目は proxy が `.toml` だけを配るためにある。MVS は木をたどるとき各版の Pome.toml しか読まない。

import { isHash, MANIFEST_FILE, type Hash } from "./hash.ts";
import { parseSourcePath, type SourcePath } from "./source-path.ts";
import { parseVersion, type Version } from "./version.ts";

export type SumRecord = {
  readonly path: SourcePath;
  readonly version: Version;
  readonly tree: Hash;
  readonly manifest: Hash;
};

export class InvalidRecord extends Error {
  constructor(
    readonly text: string,
    readonly reason: string,
  ) {
    super(`invalid sum record: ${reason}`);
  }
}

// sumdb の Log に記録を足した結果。proxy は Durable Object の RPC でこれを受け取る。
export type AppendResult =
  | { readonly ok: true; readonly id: number; readonly existing: boolean; readonly published: boolean }
  | { readonly ok: false; readonly error: "invalid_record"; readonly message: string }
  // 同じ版に別の中身の記録がある。tag を付け替えたときに起きる。
  | { readonly ok: false; readonly error: "conflict"; readonly recorded: string };

export type SumdbLog = {
  append(text: string): Promise<AppendResult>;
};

export function formatRecord(r: SumRecord): string {
  return (
    `${r.path} ${r.version.raw} ${r.tree}\n` +
    `${r.path} ${r.version.raw}/${MANIFEST_FILE} ${r.manifest}\n`
  );
}

export function parseRecord(text: string): SumRecord {
  if (!text.endsWith("\n")) throw new InvalidRecord(text, "must end with a newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 2) throw new InvalidRecord(text, "must have exactly 2 lines");
  const [tree, manifest] = lines.map((l) => {
    const fields = l.split(" ");
    if (fields.length !== 3) throw new InvalidRecord(text, `bad line \`${l}\``);
    return fields as [string, string, string];
  }) as [[string, string, string], [string, string, string]];

  if (tree[0] !== manifest[0]) throw new InvalidRecord(text, "source paths differ");
  if (manifest[1] !== `${tree[1]}/${MANIFEST_FILE}`) {
    throw new InvalidRecord(text, `second line must be \`${tree[1]}/${MANIFEST_FILE}\``);
  }
  if (!isHash(tree[2]) || !isHash(manifest[2])) throw new InvalidRecord(text, "bad hash");

  const r: SumRecord = {
    path: parseSourcePath(tree[0]),
    version: parseVersion(tree[1]),
    tree: tree[2],
    manifest: manifest[2],
  };
  if (formatRecord(r) !== text) throw new InvalidRecord(text, "not in canonical form");
  return r;
}
