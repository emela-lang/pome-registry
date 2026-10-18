import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// 自宅の LAN を叩かせない。git が引き直すまでの間に DNS が変わる余地は残るが、host を絞っているので足りる。
export async function resolvesToPublic(host: string): Promise<boolean> {
  const addresses = await lookup(host, { all: true });
  return addresses.length > 0 && addresses.every((a) => isPublic(a.address));
}

export function isPublic(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPublic(v6.slice("::ffff:".length));
  return !(v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff"));
}
