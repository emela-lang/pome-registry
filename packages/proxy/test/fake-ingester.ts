// テストの ingester。Node の側で動き、source path の名前で振る舞いを変える。
//
//   github.com/acme/good     正しい中身
//   github.com/acme/symlink  symlink のエラー（410 になる）
//   github.com/acme/liar     tree のハッシュを偽る
//   github.com/acme/moved    呼ばれるたびに中身が変わる（tag の付け替え）
//   github.com/acme/skip     v1.0.0 だけが正しく、ほかの版は symlink のエラー
//   github.com/acme/flaky    v1.1.0 は取得の一時的な失敗（502）

import {
  gzip,
  importSigningKey,
  INGEST_PART_ARCHIVE,
  INGEST_PART_META,
  type IngestMeta,
  manifestHash,
  treeHash,
  verifyRequest,
  writeTar,
} from "../../protocol/src/index.ts"; // vitest の設定から Node で読むので、束ねられるよう相対で引く

export const INGEST_SECRET = "test-secret";
let moved = 0;
export const calls: string[] = [];

export async function fakeIngester(request: Request): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const key = await importSigningKey(INGEST_SECRET);
  if (!(await verifyRequest(key, request.method, new URL(request.url).pathname, body, request.headers))) {
    return new Response("bad signature", { status: 401 });
  }
  const { path, version } = JSON.parse(new TextDecoder().decode(body)) as { path: string; version: string };
  calls.push(`${path}@${version}`);

  if (path === "github.com/acme/flaky" && version === "v1.1.0") {
    return Response.json({ error: "fetch_failed", message: "timed out" }, { status: 502 });
  }
  if (path === "github.com/acme/symlink" || (path === "github.com/acme/skip" && version !== "v1.0.0")) {
    return Response.json({ error: "symlink", message: "src/link is a symbolic link" }, { status: 422 });
  }
  if (version === "v9.9.9") {
    return Response.json({ error: "tag_not_found", message: "no tag v9.9.9" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const manifest = `[pome]\nname = "${path}"\nversion = "${version.slice(1)}"\nemela = "0.20.1"\n`;
  const lib = path === "github.com/acme/moved" ? `pub fn n() -> Int { ${moved++} }\n` : "pub fn f() -> Int { 1 }\n";
  const files = [
    { path: "Pome.toml", content: encoder.encode(manifest) },
    { path: "src/lib.emel", content: encoder.encode(lib) },
  ];
  const archive = await gzip(writeTar(files));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", archive as BufferSource));
  const meta: IngestMeta = {
    info: { version, commit: "0123456789abcdef0123456789abcdef01234567", time: "2026-10-01T00:00:00Z" },
    manifest,
    tree: path === "github.com/acme/liar" ? "h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" : await treeHash(files),
    manifestHash: await manifestHash(files[0]!.content),
    archiveSha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.content.length, 0),
  };
  const form = new FormData();
  form.set(INGEST_PART_META, JSON.stringify(meta));
  form.set(INGEST_PART_ARCHIVE, new Blob([archive.slice().buffer as ArrayBuffer], { type: "application/gzip" }), "archive.tar.gz");
  return new Response(form);
}
