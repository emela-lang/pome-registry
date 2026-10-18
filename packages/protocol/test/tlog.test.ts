import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  appendNodes,
  changedTiles,
  entryBundle,
  sumdbPaths,
  tileData,
  rootHash,
  type NodeReader,
} from "../src/index.ts";

type Vectors = {
  sizes: { size: number; root: string; tiles: { path: string; sha256: string }[] }[];
};
const { sizes } = JSON.parse(
  readFileSync(new URL("../testdata/tlog-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// testdata を作ったときの記録 i。
function rec(i: number): Uint8Array {
  const a = b64(sha256(encoder.encode(`tree${i}`)));
  const b = b64(sha256(encoder.encode(`toml${i}`)));
  return encoder.encode(
    `example.com/p${i} v1.0.${i} h1:${a}\nexample.com/p${i} v1.0.${i}/Pome.toml h1:${b}\n`,
  );
}

function memoryTree() {
  const nodes = new Map<string, Uint8Array>();
  const read: NodeReader = (level, index) => {
    const h = nodes.get(`${level}/${index}`);
    if (h === undefined) throw new Error(`missing node ${level}/${index}`);
    return h;
  };
  let size = 0;
  return {
    read,
    get size() {
      return size;
    },
    append(data: Uint8Array) {
      for (const n of appendNodes(size, data, read)) nodes.set(`${n.level}/${n.index}`, n.hash);
      size++;
    },
  };
}

describe("tlog", () => {
  it("matches the vectors for roots and tiles", () => {
    const tree = memoryTree();
    let prev = 0;
    for (const want of sizes) {
      while (tree.size < want.size) tree.append(rec(tree.size));
      expect(b64(rootHash(tree.size, tree.read)), `root of ${want.size}`).toBe(want.root);
      const tiles = changedTiles(prev, want.size);
      expect(tiles.map((t) => sumdbPaths.tile(t.level, t.index, t.width))).toEqual(
        want.tiles.map((t) => t.path),
      );
      for (const t of tiles) {
        const path = sumdbPaths.tile(t.level, t.index, t.width);
        expect(hex(sha256(tileData(t, tree.read))), path).toBe(
          want.tiles.find((w) => w.path === path)!.sha256,
        );
      }
      prev = want.size;
    }
  });

  it("hashes the empty tree as sha256 of nothing", () => {
    expect(hex(rootHash(0, () => new Uint8Array(32)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("bundles entries with a 2-byte length prefix", () => {
    expect(Array.from(entryBundle([Uint8Array.of(7), new Uint8Array(0)]))).toEqual([0, 1, 7, 0, 0]);
    expect(() => entryBundle([new Uint8Array(0x10000)])).toThrow(RangeError);
  });
});
