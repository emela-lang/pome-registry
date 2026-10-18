// Worker と ingester の間の API。
//
// ingester は資格情報を持たない純粋な変換で、(source path, version) を受けて
// info・Pome.toml・アーカイブ・ハッシュを返すだけ。R2 と sumdb への書き込みは Worker が行う。
// 経路は Workers VPC Service（公開ホスト名なし）で、加えて要求に HMAC の署名を付ける。

import type { Hash } from "./hash.ts";
import type { SourcePath } from "./source-path.ts";

export const INGEST_PATH = "/v1/ingest";

export type IngestRequest = {
  readonly path: SourcePath;
  readonly version: string;
};

export type VersionInfo = {
  readonly version: string;
  readonly commit: string; // 40桁の16進
  readonly time: string; // commit の時刻、RFC 3339 の UTC
};

// 成功の応答は multipart/form-data で、次の2つの部分を持つ。
//   meta:    IngestMeta の JSON
//   archive: アーカイブ（application/gzip）
export const INGEST_PART_META = "meta";
export const INGEST_PART_ARCHIVE = "archive";

export type IngestMeta = {
  readonly info: VersionInfo;
  readonly manifest: string; // Pome.toml の中身（UTF-8）
  readonly tree: Hash;
  readonly manifestHash: Hash;
  readonly archiveSha256: string; // 転送の検査用。sumdb には載らない
  readonly files: number;
  readonly bytes: number;
};

// 失敗の応答は JSON。4xx は版そのものの問題で、Worker はこれを短い TTL でキャッシュし、同じ失敗で
// ingester を叩かせない。fetch_failed（取得の一時的な失敗）だけは 502 で返し、キャッシュさせない。
export type IngestErrorCode =
  | "host_not_allowed"
  | "invalid_request"
  | "tag_not_found"
  | "manifest_missing"
  | "manifest_name_mismatch"
  | "manifest_version_mismatch" // tag から `v` を外したものと [pome].version が違う
  | "manifest_invalid" // TOML として読めない、[pome] がない
  | "bad_path" // UTF-8 でない、改行やバックスラッシュを含むなど
  | "symlink"
  | "submodule"
  | "too_large"
  | "fetch_failed";

export type IngestError = {
  readonly error: IngestErrorCode;
  readonly message: string;
};

export const limits = {
  maxFiles: 10_000,
  maxTreeBytes: 32 * 1024 * 1024,
  maxManifestBytes: 64 * 1024,
  fetchTimeoutMs: 30_000,
} as const;

// 最初は host を絞る。自宅の LAN を叩かせない（SSRF）ため、DNS で引いた先の検査とは別に置く。
// 今は github.com だけ（リポジトリの境界を source path から決められる host、4.7）。
export const defaultAllowedHosts: readonly string[] = ["github.com"];

// --- 署名 ---
//
//   canonical = method + "\n" + pathname + "\n" + timestamp + "\n" + hex(sha256(body))
//   signature = base64url(HMAC-SHA256(secret, canonical))

export const HEADER_TIMESTAMP = "x-pome-timestamp";
export const HEADER_SIGNATURE = "x-pome-signature";
export const MAX_CLOCK_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

export async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signRequest(
  key: CryptoKey,
  method: string,
  pathname: string,
  body: Uint8Array,
  now: Date = new Date(),
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const mac = await crypto.subtle.sign("HMAC", key, await canonical(method, pathname, timestamp, body));
  return { [HEADER_TIMESTAMP]: timestamp, [HEADER_SIGNATURE]: toBase64Url(new Uint8Array(mac)) };
}

export async function verifyRequest(
  key: CryptoKey,
  method: string,
  pathname: string,
  body: Uint8Array,
  headers: { get(name: string): string | null },
  now: Date = new Date(),
): Promise<boolean> {
  const timestamp = headers.get(HEADER_TIMESTAMP);
  const signature = headers.get(HEADER_SIGNATURE);
  if (timestamp === null || signature === null || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
  const mac = fromBase64Url(signature);
  if (mac === undefined) return false;
  // verify は定数時間で比べる。
  return crypto.subtle.verify(
    "HMAC",
    key,
    mac as BufferSource,
    await canonical(method, pathname, timestamp, body),
  );
}

async function canonical(
  method: string,
  pathname: string,
  timestamp: string,
  body: Uint8Array,
): Promise<BufferSource> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return encoder.encode(`${method.toUpperCase()}\n${pathname}\n${timestamp}\n${hex}`) as BufferSource;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}
