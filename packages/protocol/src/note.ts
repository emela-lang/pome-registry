// 署名付きの note（C2SP signed-note）と checkpoint（C2SP tlog-checkpoint）。
//
//   note    = 本文 + "\n" + 署名の行
//   署名の行 = "— " + 鍵の名前 + " " + base64(鍵のハッシュ 4 バイト || Ed25519 の署名) + "\n"
//
//   秘密鍵 = "PRIVATE+KEY+" + 名前 + "+" + 鍵のハッシュ（8桁の16進） + "+" + base64(0x01 || seed)
//   公開鍵 = 名前 + "+" + 鍵のハッシュ + "+" + base64(0x01 || 公開鍵)
//   鍵のハッシュ = sha256(名前 + "\n" + 0x01 || 公開鍵) の先頭 4 バイト
//
// checkpoint の本文は「origin、木の大きさ、根の base64」の3行。

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

const ALG_ED25519 = 0x01;
const SIG_PREFIX = "— ";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class InvalidNote extends Error {
  constructor(readonly reason: string) {
    super(`invalid note: ${reason}`);
  }
}

export type NoteSigner = {
  readonly name: string;
  readonly keyHash: number;
  readonly seed: Uint8Array;
};

export type NoteVerifier = {
  readonly name: string;
  readonly keyHash: number;
  readonly publicKey: Uint8Array;
};

export function parseSignerKey(skey: string): NoteSigner {
  // base64 の鍵は `+` を含みうるので、4つ目の `+` より後は全部が鍵。
  const parts = skey.split("+");
  if (parts.length < 5 || parts[0] !== "PRIVATE" || parts[1] !== "KEY") {
    throw new InvalidNote("malformed signer key");
  }
  const [, , name, hash] = parts as [string, string, string, string];
  const key = parts.slice(4).join("+");
  const raw = decodeKey(key);
  if (raw.length !== 33) throw new InvalidNote("signer key must be 32 bytes");
  const seed = raw.slice(1);
  const verifier = makeVerifier(name, ed25519.getPublicKey(seed));
  if (verifier.keyHash !== parseKeyHash(hash)) throw new InvalidNote("signer key hash mismatch");
  return { name, keyHash: verifier.keyHash, seed };
}

export function parseVerifierKey(vkey: string): NoteVerifier {
  const parts = vkey.split("+");
  if (parts.length < 3) throw new InvalidNote("malformed verifier key");
  const [name, hash] = parts as [string, string];
  const key = parts.slice(2).join("+");
  const raw = decodeKey(key);
  if (raw.length !== 33) throw new InvalidNote("verifier key must be 32 bytes");
  const verifier = makeVerifier(name, raw.slice(1));
  if (verifier.keyHash !== parseKeyHash(hash)) throw new InvalidNote("verifier key hash mismatch");
  return verifier;
}

export function verifierFor(signer: NoteSigner): NoteVerifier {
  return makeVerifier(signer.name, ed25519.getPublicKey(signer.seed));
}

export function formatVerifierKey(v: NoteVerifier): string {
  return `${v.name}+${hex8(v.keyHash)}+${toBase64(withAlg(v.publicKey))}`;
}

export function formatSignerKey(s: NoteSigner): string {
  return `PRIVATE+KEY+${s.name}+${hex8(s.keyHash)}+${toBase64(withAlg(s.seed))}`;
}

export function generateSigner(name: string): NoteSigner {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  return { name, keyHash: makeVerifier(name, ed25519.getPublicKey(seed)).keyHash, seed };
}

export function signNote(text: string, signer: NoteSigner): string {
  checkText(text);
  const sig = ed25519.sign(encoder.encode(text), signer.seed);
  const blob = new Uint8Array(4 + sig.length);
  new DataView(blob.buffer).setUint32(0, signer.keyHash);
  blob.set(sig, 4);
  return `${text}\n${SIG_PREFIX}${signer.name} ${toBase64(blob)}\n`;
}

// 本文を返す。verifier の有効な署名がなければ InvalidNote。知らない鍵の署名は無視する。
export function openNote(signed: string, verifier: NoteVerifier): string {
  const split = signed.lastIndexOf("\n\n");
  if (split < 0) throw new InvalidNote("missing signature block");
  const text = signed.slice(0, split + 1);
  checkText(text);
  const block = signed.slice(split + 2);
  if (!block.endsWith("\n")) throw new InvalidNote("signature block must end with a newline");
  for (const line of block.slice(0, -1).split("\n")) {
    if (!line.startsWith(SIG_PREFIX)) throw new InvalidNote(`bad signature line \`${line}\``);
    const [name, b64, ...rest] = line.slice(SIG_PREFIX.length).split(" ");
    if (name === undefined || b64 === undefined || rest.length > 0) {
      throw new InvalidNote(`bad signature line \`${line}\``);
    }
    if (name !== verifier.name) continue;
    const blob = fromBase64(b64);
    if (blob === undefined || blob.length !== 4 + 64) continue;
    if (new DataView(blob.buffer).getUint32(0) !== verifier.keyHash) continue;
    if (ed25519.verify(blob.slice(4), encoder.encode(text), verifier.publicKey)) return text;
  }
  throw new InvalidNote(`no valid signature by \`${verifier.name}\``);
}

export type Checkpoint = {
  readonly origin: string;
  readonly size: number;
  readonly root: Uint8Array;
};

export function formatCheckpoint(c: Checkpoint): string {
  if (c.root.length !== 32) throw new RangeError("root must be 32 bytes");
  return `${c.origin}\n${c.size}\n${toBase64(c.root)}\n`;
}

export function parseCheckpoint(text: string): Checkpoint {
  const lines = text.split("\n");
  // 3行の後に拡張の行があってもよい（C2SP）。最後は空になる。
  if (lines.length < 4 || lines[lines.length - 1] !== "") throw new InvalidNote("bad checkpoint");
  const [origin, size, root] = lines as [string, string, string];
  if (origin === "" || !/^(0|[1-9][0-9]*)$/.test(size) || !Number.isSafeInteger(Number(size))) {
    throw new InvalidNote("bad checkpoint");
  }
  const hash = fromBase64(root);
  if (hash === undefined || hash.length !== 32) throw new InvalidNote("bad checkpoint root");
  return { origin, size: Number(size), root: hash };
}

function makeVerifier(name: string, publicKey: Uint8Array): NoteVerifier {
  if (!isValidName(name)) throw new InvalidNote(`bad key name \`${name}\``);
  const digest = sha256(concat(encoder.encode(`${name}\n`), withAlg(publicKey)));
  return { name, keyHash: new DataView(digest.buffer).getUint32(0), publicKey };
}

function isValidName(name: string): boolean {
  return name !== "" && !name.includes("+") && !/\s/u.test(name);
}

function checkText(text: string): void {
  if (!text.endsWith("\n")) throw new InvalidNote("text must end with a newline");
  // 改行のほかの制御文字は持てない。
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) throw new InvalidNote("text has control characters");
  // 対になっていないサロゲートは UTF-8 にできない。
  if (decoder.decode(encoder.encode(text)) !== text) throw new InvalidNote("text is not valid UTF-8");
}

function decodeKey(b64: string): Uint8Array {
  const raw = fromBase64(b64);
  if (raw === undefined || raw[0] !== ALG_ED25519) throw new InvalidNote("unknown key algorithm");
  return raw;
}

function parseKeyHash(s: string): number {
  if (!/^[0-9a-f]{8}$/.test(s)) throw new InvalidNote("bad key hash");
  return parseInt(s, 16);
}

function withAlg(key: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(ALG_ED25519), key);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, "0");
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(s: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return undefined;
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
