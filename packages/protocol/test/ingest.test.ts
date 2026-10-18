import { describe, expect, it } from "vitest";
import { HEADER_TIMESTAMP, importSigningKey, signRequest, verifyRequest } from "../src/index.ts";

const body = new TextEncoder().encode(JSON.stringify({ path: "github.com/a/b", version: "v1.0.0" }));
const now = new Date("2026-10-17T00:00:00Z");

describe("ingest の署名", async () => {
  const key = await importSigningKey("test-secret");
  const headers = new Headers(await signRequest(key, "POST", "/v1/ingest", body, now));

  it("同じ要求なら通る", async () => {
    expect(await verifyRequest(key, "POST", "/v1/ingest", body, headers, now)).toBe(true);
  });

  it("本文，パス，鍵が違えば落ちる", async () => {
    const other = new TextEncoder().encode("{}");
    expect(await verifyRequest(key, "POST", "/v1/ingest", other, headers, now)).toBe(false);
    expect(await verifyRequest(key, "POST", "/v1/other", body, headers, now)).toBe(false);
    expect(await verifyRequest(await importSigningKey("x"), "POST", "/v1/ingest", body, headers, now)).toBe(false);
  });

  it("時刻のずれが大きければ落ちる", async () => {
    const late = new Date(now.getTime() + 301_000);
    expect(await verifyRequest(key, "POST", "/v1/ingest", body, headers, late)).toBe(false);
  });

  it("ヘッダがなければ落ちる", async () => {
    const h = new Headers(headers);
    h.delete(HEADER_TIMESTAMP);
    expect(await verifyRequest(key, "POST", "/v1/ingest", body, h, now)).toBe(false);
  });
});
