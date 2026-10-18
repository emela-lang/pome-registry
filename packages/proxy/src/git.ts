// `@v/list` の元。リポジトリ（source path から `/vN` を外したもの）の tag を、git の smart HTTP の ref の一覧から読む。
// clone はしない。ref の一覧は1回の GET で返り、ingester を通さずに Worker から引ける。

import { compareVersions, isVersion, isVersionOf, parseVersion, repositoryOf, type SourcePath } from "@pome-registry/protocol";

export class RepositoryNotFound extends Error {}

export async function listVersions(path: SourcePath, fetcher: typeof fetch = fetch): Promise<string[]> {
  const res = await fetcher(`https://${repositoryOf(path)}.git/info/refs?service=git-upload-pack`, {
    headers: { "user-agent": "pome-proxy", accept: "application/x-git-upload-pack-advertisement" },
    redirect: "follow",
  });
  // 無いリポジトリと非公開のリポジトリは、どちらも 401 か 404 になる。
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new RepositoryNotFound(path);
  if (!res.ok) throw new Error(`git ls-remote of ${path} failed: ${res.status}`);
  const tags = parseTags(new Uint8Array(await res.arrayBuffer()));
  return tags
    .filter(isVersion)
    .map(parseVersion)
    // 同じリポジトリでも、major と `/vN` が合わない tag はこの Pome の版ではない。
    .filter((v) => isVersionOf(path, v))
    .sort(compareVersions)
    .map((v) => v.raw);
}

// pkt-line の列から refs/tags/ の名前を取り出す。注釈付きの tag の `^{}` は同じ tag なので除く。
export function parseTags(body: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const tags = new Set<string>();
  let at = 0;
  while (at + 4 <= body.length) {
    // 長さは4桁の16進で、自分の4バイトを含む。0000 は区切り。
    const len = parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (Number.isNaN(len) || (len > 0 && len < 4) || at + len > body.length) throw new Error("bad pkt-line");
    if (len === 0) {
      at += 4;
      continue;
    }
    const line = decoder.decode(body.subarray(at + 4, at + len)).replace(/\n$/, "");
    at += len;
    const ref = line.split("\0")[0]!.split(" ")[1];
    if (ref?.startsWith("refs/tags/") && !ref.endsWith("^{}")) tags.add(ref.slice("refs/tags/".length));
  }
  return [...tags];
}
