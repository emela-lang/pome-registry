// テストで同居させる sumdb の Log が使う束縛。
interface Env {
  SUMDB: R2Bucket;
  SUMDB_SIGNER_KEY: string;
}

declare namespace Cloudflare {
  interface Env {
    SUMDB: R2Bucket;
    SUMDB_SIGNER_KEY: string;
    TEST_VERIFIER_KEY: string;
  }
}
