// テストの入口。proxy と、別の Worker にある sumdb の Log を1つの Worker に置く。
export { default } from "../src/index.ts";
export { Log } from "../../sumdb/src/log.ts";
