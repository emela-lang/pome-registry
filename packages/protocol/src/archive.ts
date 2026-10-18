// proxy が配るアーカイブ `.tar.gz`。ingester が書き、proxy の Worker が読み直して `h1:` を確かめる。
//
// 中身は Pome の根からの相対パスの通常ファイルだけで、ディレクトリの項目は持たない。
// 時刻、所有者、モードは固定する（中身のハッシュに入らないので、同じ木から同じバイト列を作るため）。
// 100 バイトを超えるパスと ASCII でないパスは、pax の拡張ヘッダの `path` で書く。

import type { TreeFile } from "./hash.ts";

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class InvalidArchive extends Error {
  constructor(readonly reason: string) {
    super(`invalid archive: ${reason}`);
  }
}

export function writeTar(files: readonly TreeFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const name = encoder.encode(f.path);
    if (name.length > 100 || /[^\x20-\x7e]/.test(f.path)) {
      const record = paxRecord("path", f.path);
      chunks.push(header("PaxHeader", record.length, "x"), padded(record));
      chunks.push(header("pax-path", f.content.length, "0"), padded(f.content));
    } else {
      chunks.push(header(f.path, f.content.length, "0"), padded(f.content));
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  return concat(chunks);
}

export function readTar(tar: Uint8Array): TreeFile[] {
  const files: TreeFile[] = [];
  let paxPath: string | undefined;
  let at = 0;
  for (;;) {
    if (at + BLOCK > tar.length) throw new InvalidArchive("truncated");
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (checksum(h) !== octal(h, 148, 8)) throw new InvalidArchive("bad header checksum");
    if (ascii(h, 257, 6) !== "ustar") throw new InvalidArchive("not ustar");
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156]!);
    const start = at + BLOCK;
    const end = start + size;
    if (end > tar.length) throw new InvalidArchive("truncated");
    const body = tar.subarray(start, end);
    at = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      paxPath = parsePax(body).get("path");
      continue;
    }
    if (type !== "0" && type !== "\0") throw new InvalidArchive(`unsupported entry type \`${type}\``);
    let path = paxPath;
    if (path === undefined) {
      const name = cString(h, 0, 100);
      const prefix = cString(h, 345, 155);
      path = prefix === "" ? name : `${prefix}/${name}`;
    }
    paxPath = undefined;
    files.push({ path, content: body.slice() });
  }
  if (paxPath !== undefined) throw new InvalidArchive("pax header without an entry");
  return files;
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream("gzip"), Infinity);
}

// 展開した大きさが limit を超えたら止める（gzip の爆弾を読み切らない）。
export async function gunzip(data: Uint8Array, limit: number): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream("gzip"), limit);
}

async function pipe(data: Uint8Array, transform: TransformStream<BufferSource, Uint8Array>, limit: number) {
  const writer = transform.writable.getWriter();
  // 読み手が途中でやめると書き手は中断される。その失敗は読み手の側で扱う。
  writer
    .write(data as BufferSource)
    .then(() => writer.close())
    .catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new InvalidArchive(`larger than ${limit} bytes when expanded`);
    }
    chunks.push(value);
  }
  return concat(chunks);
}

function header(name: string, size: number, type: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  h.set(encoder.encode(name), 0);
  h.set(encoder.encode("0000644\0"), 100);
  h.set(encoder.encode("0000000\0"), 108);
  h.set(encoder.encode("0000000\0"), 116);
  h.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  h.set(encoder.encode("00000000000\0"), 136);
  h[156] = type.charCodeAt(0);
  h.set(encoder.encode("ustar\0"), 257);
  h.set(encoder.encode("00"), 263);
  h.set(encoder.encode(`${checksum(h).toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

// 検査和は、検査和の欄を空白とみなしたヘッダのバイトの和。
function checksum(h: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum;
}

// pax の記録は "<長さ> <key>=<value>\n" で、長さは自分の桁を含む。
function paxRecord(key: string, value: string): Uint8Array {
  const rest = encoder.encode(` ${key}=${value}\n`).length;
  let n = rest + 1;
  while (String(n).length + rest !== n) n = String(n).length + rest;
  return encoder.encode(`${n} ${key}=${value}\n`);
}

function parsePax(body: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) throw new InvalidArchive("bad pax header");
    const n = Number(ascii(body, at, space - at));
    if (!Number.isSafeInteger(n) || n <= space - at || at + n > body.length || body[at + n - 1] !== 0x0a) {
      throw new InvalidArchive("bad pax header");
    }
    const record = utf8(body.subarray(space + 1, at + n - 1));
    const eq = record.indexOf("=");
    if (eq < 0) throw new InvalidArchive("bad pax header");
    out.set(record.slice(0, eq), record.slice(eq + 1));
    at += n;
  }
  return out;
}

function octal(h: Uint8Array, at: number, len: number): number {
  const s = ascii(h, at, len).replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (!/^[0-7]+$/.test(s)) throw new InvalidArchive("bad octal field");
  return parseInt(s, 8);
}

function cString(h: Uint8Array, at: number, len: number): string {
  const field = h.subarray(at, at + len);
  const nul = field.indexOf(0);
  return utf8(nul < 0 ? field : field.subarray(0, nul));
}

function ascii(h: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...h.subarray(at, at + len)).replace(/\0.*$/s, "");
}

function utf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new InvalidArchive("path is not UTF-8");
  }
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(data);
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
