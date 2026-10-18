// sumdb の木。RFC 6962 の Merkle tree。
//
//   leaf = sha256(0x00 || 記録)
//   node = sha256(0x01 || left || right)
//
// 木は「完全な部分木」の節を (level, index) で持つ。level の節 index は、葉
// [index * 2^level, (index + 1) * 2^level) をまとめたもの。葉を1つ足すたびに、
// 埋まった節が上へ伝わる。SQLite の Log はこの節を全部しまい、tile も根もここから作る。
//
// 計算は同期にする。Durable Object の中で await を挟むと、ほかの追記が割り込むため。

import { sha256 } from "@noble/hashes/sha2.js";
import { TILE_WIDTH } from "./layout.ts";

export const TILE_HEIGHT = 8; // 1 << TILE_HEIGHT === TILE_WIDTH

export type NodeHash = Uint8Array; // 32 バイト

export type StoredNode = {
  readonly level: number;
  readonly index: number;
  readonly hash: NodeHash;
};

// 節を引く。無い節を求めたら呼ぶ側の誤りなので、例外にしてよい。
export type NodeReader = (level: number, index: number) => NodeHash;

export function recordHash(data: Uint8Array): NodeHash {
  const buf = new Uint8Array(1 + data.length);
  buf[0] = 0x00;
  buf.set(data, 1);
  return sha256(buf);
}

export function nodeHash(left: NodeHash, right: NodeHash): NodeHash {
  const buf = new Uint8Array(1 + 64);
  buf[0] = 0x01;
  buf.set(left, 1);
  buf.set(right, 33);
  return sha256(buf);
}

// 大きさ n の木に記録 n を足したときに、新しく埋まる節。最初が葉。
export function appendNodes(n: number, data: Uint8Array, read: NodeReader): StoredNode[] {
  checkSize(n);
  let hash = recordHash(data);
  let index = n;
  const out: StoredNode[] = [{ level: 0, index, hash }];
  for (let level = 0; index % 2 === 1; level++) {
    hash = nodeHash(read(level, index - 1), hash);
    index = (index - 1) / 2;
    out.push({ level: level + 1, index, hash });
  }
  return out;
}

// 大きさ n の木の根。n = 0 は空の木で、sha256("") になる。
export function rootHash(n: number, read: NodeReader): NodeHash {
  checkSize(n);
  if (n === 0) return sha256(new Uint8Array(0));
  // n を2の冪に分けた完全な部分木を、右から畳む。
  const subtrees: NodeHash[] = [];
  let start = 0;
  for (let level = Math.floor(Math.log2(n)); level >= 0; level--) {
    const size = 2 ** level;
    if (n - start >= size) {
      subtrees.push(read(level, start / size));
      start += size;
    }
  }
  let hash = subtrees[subtrees.length - 1]!;
  for (let i = subtrees.length - 2; i >= 0; i--) hash = nodeHash(subtrees[i]!, hash);
  return hash;
}

// tile は level L について、tree の level 8L の節を 256 個ずつ並べたもの。
// 幅 W が 256 に満たないものは partial tile。
export type Tile = {
  readonly level: number;
  readonly index: number;
  readonly width: number;
};

// 大きさ old から new に伸びたとき、中身が変わった tile。
export function changedTiles(oldSize: number, newSize: number): Tile[] {
  checkSize(oldSize);
  checkSize(newSize);
  const tiles: Tile[] = [];
  for (let level = 0; Math.floor(newSize / TILE_WIDTH ** level) > 0; level++) {
    const oldN = Math.floor(oldSize / TILE_WIDTH ** level);
    const newN = Math.floor(newSize / TILE_WIDTH ** level);
    if (oldN === newN) continue;
    const last = Math.floor(newN / TILE_WIDTH);
    for (let index = Math.floor(oldN / TILE_WIDTH); index < last; index++) {
      tiles.push({ level, index, width: TILE_WIDTH });
    }
    const width = newN - last * TILE_WIDTH;
    if (width > 0) tiles.push({ level, index: last, width });
  }
  return tiles;
}

export function tileData(tile: Tile, read: NodeReader): Uint8Array {
  const out = new Uint8Array(tile.width * 32);
  const level = tile.level * TILE_HEIGHT;
  for (let i = 0; i < tile.width; i++) {
    out.set(read(level, tile.index * TILE_WIDTH + i), i * 32);
  }
  return out;
}

// entries tile（C2SP tlog-tiles）: 記録ごとに、長さ（2バイト、big endian）と中身を並べる。
export function entryBundle(records: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const r of records) {
    if (r.length > 0xffff) throw new RangeError(`record too long: ${r.length} bytes`);
    size += 2 + r.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const r of records) {
    out[at] = r.length >> 8;
    out[at + 1] = r.length & 0xff;
    out.set(r, at + 2);
    at += 2 + r.length;
  }
  return out;
}

function checkSize(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bad tree size ${n}`);
}
