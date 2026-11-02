import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// checkpoint の署名は protocol の testdata の鍵で作り、同じ鍵の公開側で確かめる。
const vectors = JSON.parse(
  readFileSync(new URL("../protocol/testdata/tlog-vectors.json", import.meta.url), "utf8"),
) as { signerKey: string; verifierKey: string };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { SUMDB_VERIFIER_KEY: vectors.verifierKey, TEST_SIGNER_KEY: vectors.signerKey },
      },
    }),
  ],
});
