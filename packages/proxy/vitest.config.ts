import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fakeIngester, INGEST_SECRET } from "./test/fake-ingester.ts";

const vectors = JSON.parse(
  readFileSync(new URL("../protocol/testdata/tlog-vectors.json", import.meta.url), "utf8"),
) as { signerKey: string; verifierKey: string };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
      miniflare: {
        bindings: { INGEST_SECRET, SUMDB_SIGNER_KEY: vectors.signerKey, TEST_VERIFIER_KEY: vectors.verifierKey },
        serviceBindings: { INGESTER: fakeIngester },
      },
    }),
  ],
});
