import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InvalidTreePath, manifestHash, treeHash } from "../src/index.ts";

type Vectors = { vectors: { name: string; files: { path: string; base64: string }[]; h1: string }[] };
const { vectors } = JSON.parse(
  readFileSync(new URL("../testdata/hash-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("treeHash", () => {
  for (const v of vectors) {
    it(v.name, async () => {
      const files = v.files.map((f) => ({ path: f.path, content: decode(f.base64) }));
      expect(await treeHash(files)).toBe(v.h1);
      expect(await treeHash([...files].reverse())).toBe(v.h1);
    });
  }

  it("manifestHash は Pome.toml だけの木と同じ", async () => {
    const v = vectors.find((v) => v.name === "manifest only")!;
    expect(await manifestHash(decode(v.files[0]!.base64))).toBe(v.h1);
  });

  it.each(["", "/abs", "a//b", "./a", "a/../b", "a\nb", "a\\b", ".git/config"])(
    "正しくないパス %j を拒否する",
    async (path) => {
      await expect(treeHash([{ path, content: new Uint8Array() }])).rejects.toBeInstanceOf(InvalidTreePath);
    },
  );

  it("重複したパスを拒否する", async () => {
    const f = { path: "a", content: new Uint8Array() };
    await expect(treeHash([f, f])).rejects.toBeInstanceOf(InvalidTreePath);
  });
});
