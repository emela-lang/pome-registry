import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatCheckpoint,
  formatSignerKey,
  generateSigner,
  formatVerifierKey,
  InvalidNote,
  openNote,
  parseCheckpoint,
  parseSignerKey,
  parseVerifierKey,
  signNote,
  verifierFor,
} from "../src/index.ts";

type Vectors = {
  sizes: { size: number; root: string }[];
  signerKey: string;
  verifierKey: string;
  note: string;
};
const v = JSON.parse(
  readFileSync(new URL("../testdata/tlog-vectors.json", import.meta.url), "utf8"),
) as Vectors;
const last = v.sizes[v.sizes.length - 1]!;
const root = Uint8Array.from(atob(last.root), (c) => c.charCodeAt(0));

describe("note", () => {
  it("signs a checkpoint exactly as the vector", () => {
    const signer = parseSignerKey(v.signerKey);
    const text = formatCheckpoint({ origin: "sum.example.test", size: last.size, root });
    expect(signNote(text, signer)).toBe(v.note);
    expect(formatVerifierKey(verifierFor(signer))).toBe(v.verifierKey);
    expect(formatSignerKey(signer)).toBe(v.signerKey);
  });

  it("generates keys that round-trip", () => {
    for (let i = 0; i < 50; i++) roundTrip();
  });

  function roundTrip() {
    const signer = generateSigner("sum.example.test");
    const parsed = parseSignerKey(formatSignerKey(signer));
    expect(openNote(signNote("x\n", parsed), parseVerifierKey(formatVerifierKey(verifierFor(signer))))).toBe("x\n");
  }

  it("opens the signed note in the vectors", () => {
    const text = openNote(v.note, parseVerifierKey(v.verifierKey));
    const c = parseCheckpoint(text);
    expect(c.origin).toBe("sum.example.test");
    expect(c.size).toBe(last.size);
    expect(c.root).toEqual(root);
  });

  it("rejects a tampered note", () => {
    const verifier = parseVerifierKey(v.verifierKey);
    expect(() => openNote(v.note.replace(String(last.size), "66001"), verifier)).toThrow(InvalidNote);
  });

  it("rejects a note signed by another key with the same name", () => {
    const other = verifierFor({ name: "sum.example.test", keyHash: 0, seed: new Uint8Array(32).fill(9) });
    expect(() => openNote(v.note, other)).toThrow(InvalidNote);
  });
});
