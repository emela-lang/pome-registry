import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gunzip, gzip, InvalidArchive, readTar, treeHash, writeTar } from "../src/index.ts";

const encoder = new TextEncoder();
const file = (path: string, text: string) => ({ path, content: encoder.encode(text) });

const files = [
  file("Pome.toml", '[pome]\nname = "github.com/acme/x"\n'),
  file("src/lib.emel", "pub fn f() -> Int { 1 }\n"),
  file(`src/${"a".repeat(120)}.emel`, "long\n"),
  file("src/日本語.emel", "utf-8\n"),
  file("empty", ""),
];

describe("archive", () => {
  it("round-trips through tar and gzip with the same h1", async () => {
    const back = readTar(await gunzip(await gzip(writeTar(files)), 1 << 20));
    expect(await treeHash(back)).toBe(await treeHash(files));
    expect(back.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort());
  });

  it("is deterministic", () => {
    expect(writeTar(files)).toEqual(writeTar([...files].reverse()));
  });

  it("is readable by the system tar", () => {
    const dir = mkdtempSync(join(tmpdir(), "pome-tar-"));
    writeFileSync(join(dir, "a.tar"), writeTar(files));
    execFileSync("tar", ["-xf", "a.tar"], { cwd: dir });
    for (const f of files) expect(readFileSync(join(dir, f.path))).toEqual(Buffer.from(f.content));
  });

  it("rejects a broken header and a gzip bomb", async () => {
    const tar = writeTar(files);
    tar[0] = tar[0]! ^ 1;
    expect(() => readTar(tar)).toThrow(InvalidArchive);
    await expect(gunzip(await gzip(new Uint8Array(4096)), 1024)).rejects.toThrow(InvalidArchive);
  });

  it("rejects entries other than regular files", () => {
    const tar = writeTar([file("a", "x")]);
    tar[156] = "5".charCodeAt(0); // ディレクトリ
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i]!;
    tar.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    expect(() => readTar(tar)).toThrow(/unsupported entry type/);
  });
});
