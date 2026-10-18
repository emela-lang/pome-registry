// sumdb の署名の鍵を作る。秘密鍵は `wrangler secret put SUMDB_SIGNER_KEY` に渡し、
// 公開鍵はコンパイラに埋め込む（4.7 の EMELA_POMESUMDB の既定）。
//
//   pnpm --filter @pome-registry/sumdb genkey sum.emela.ab2m.link

import { formatSignerKey, formatVerifierKey, generateSigner, verifierFor } from "@pome-registry/protocol";

const name = process.argv[2];
if (name === undefined) {
  console.error("usage: genkey <name>");
  process.exit(2);
}
const signer = generateSigner(name);
console.log(`signer:   ${formatSignerKey(signer)}`);
console.log(`verifier: ${formatVerifierKey(verifierFor(signer))}`);
