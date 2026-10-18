import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 署名の鍵は protocol の testdata のものを使う。
const vectors = JSON.parse(
  readFileSync(new URL("../protocol/testdata/tlog-vectors.json", import.meta.url), "utf8"),
) as { signerKey: string; verifierKey: string };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { SUMDB_SIGNER_KEY: vectors.signerKey, TEST_VERIFIER_KEY: vectors.verifierKey },
      },
    }),
  ],
});
