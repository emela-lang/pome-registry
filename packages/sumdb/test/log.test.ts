import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  appendNodes,
  formatRecord,
  type NodeReader,
  openNote,
  parseCheckpoint,
  parseSourcePath,
  parseVerifierKey,
  parseVersion,
  rootHash,
  tileData,
} from "@pome-registry/protocol";
import { describe, expect, it } from "vitest";
import { objectKey } from "../src/index.ts";

const H = (c: string) => `h1:${c.repeat(43)}=` as const;

function record(i: number, tree = H("A")): string {
  return formatRecord({
    path: parseSourcePath(`github.com/acme/p${i}`),
    version: parseVersion(`v1.0.${i}`),
    tree,
    manifest: H("B"),
  });
}

async function get(path: string): Promise<Response> {
  return SELF.fetch(`https://sum.example.test/${path}`);
}

async function checkpoint() {
  const res = await get("checkpoint");
  expect(res.status).toBe(200);
  return parseCheckpoint(openNote(await res.text(), parseVerifierKey(env.TEST_VERIFIER_KEY)));
}

describe("Log", () => {
  it("appends a record and publishes a signed checkpoint and a lookup", async () => {
    const log = env.LOG.getByName("one");
    expect(await log.append(record(0))).toEqual({ ok: true, id: 0, existing: false, published: true });

    const c = await checkpoint();
    expect(c.origin).toBe("sum.example.test");
    expect(c.size).toBe(1);

    const res = await get("lookup/github.com/acme/p0@v1.0.0");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith(`0\n${record(0)}\n`)).toBe(true);
    openNote(body.slice(`0\n${record(0)}\n`.length), parseVerifierKey(env.TEST_VERIFIER_KEY));
  });

  it("returns the existing id for the same record and refuses a different one", async () => {
    const log = env.LOG.getByName("dup");
    await log.append(record(0));
    expect(await log.append(record(0))).toEqual({ ok: true, id: 0, existing: true, published: true });
    expect(await log.append(record(0, H("C")))).toEqual({ ok: false, error: "conflict", recorded: record(0) });
    expect(await log.size()).toBe(1);
  });

  it("refuses a malformed record", async () => {
    const result = await env.LOG.getByName("bad").append("github.com/acme/p v1.0.0 h1:x\n");
    expect(result.ok).toBe(false);
  });

  it("publishes tiles that match the tree", async () => {
    const log = env.LOG.getByName("many");
    const nodes = new Map<string, Uint8Array>();
    const read: NodeReader = (l, i) => nodes.get(`${l}/${i}`)!;
    const encoder = new TextEncoder();
    const n = 300;
    for (let i = 0; i < n; i++) {
      expect((await log.append(record(i))).ok).toBe(true);
      for (const x of appendNodes(i, encoder.encode(record(i)), read)) nodes.set(`${x.level}/${x.index}`, x.hash);
    }

    const c = await checkpoint();
    expect(c.size).toBe(n);
    expect(c.root).toEqual(rootHash(n, read));

    for (const [path, tile] of [
      ["tile/0/000", { level: 0, index: 0, width: 256 }],
      ["tile/0/001.p/44", { level: 0, index: 1, width: 44 }],
      ["tile/1/000.p/1", { level: 1, index: 0, width: 1 }],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer()), path).toEqual(tileData(tile, read));
    }

    const entries = new Uint8Array(await (await get("tile/entries/001.p/44")).arrayBuffer());
    const first = encoder.encode(record(256));
    expect((entries[0]! << 8) | entries[1]!).toBe(first.length);
    expect(entries.slice(2, 2 + first.length)).toEqual(first);
  });
});

describe("objectKey", () => {
  it("accepts the sumdb paths", () => {
    expect(objectKey("checkpoint")).toBe("checkpoint");
    expect(objectKey("tile/0/x001/234.p/7")).toBe("tile/0/x001/234.p/7");
    expect(objectKey("tile/entries/000")).toBe("tile/entries/000");
    expect(objectKey("lookup/github.com/!acme/x@v1.2.3")).toBe("lookup/github.com/!acme/x@v1.2.3");
  });

  it("rejects anything else", () => {
    for (const p of ["", "tile/0/1", "tile/0/000.p/256", "tile/0/000.p/0", "lookup/github.com/Acme/x@v1.2.3", "lookup/github.com/acme/x@1.2.3", "lookup/x", "other"]) {
      expect(objectKey(p), p).toBeUndefined();
    }
  });

  it("answers 404 and 405", async () => {
    expect((await get("lookup/github.com/acme/none@v1.0.0")).status).toBe(404);
    expect((await SELF.fetch("https://sum.example.test/checkpoint", { method: "POST" })).status).toBe(405);
  });
});
