// ingester を起動する。設定は環境変数で渡す。
//
//   INGEST_SECRET    proxy の Worker と共有する HMAC の鍵（必須）
//   PORT             待ち受けるポート（既定 8080）
//   ALLOWED_HOSTS    取り込みを許す host をカンマで（既定は protocol の defaultAllowedHosts）
//   MAX_CONCURRENCY  同時に取り込む数（既定 4）

import { defaultAllowedHosts, limits } from "@pome-registry/protocol";
import { resolvesToPublic } from "./net.ts";
import { createIngester } from "./server.ts";

const secret = process.env.INGEST_SECRET;
if (secret === undefined || secret.length < 32) {
  console.error("INGEST_SECRET must be set (at least 32 characters)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const allowedHosts = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? defaultAllowedHosts;

const server = createIngester({
  secret,
  maxConcurrency: Number(process.env.MAX_CONCURRENCY ?? 4),
  allowedHosts,
  repositoryUrl: (repository) => `https://${repository}.git`,
  checkHost: resolvesToPublic,
  git: { timeoutMs: limits.fetchTimeoutMs },
});
server.listen(port, () => console.log(`ingester listening on :${port}, hosts: ${allowedHosts.join(", ")}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
