// sumdb の読みの口。checkpoint、lookup、tile を R2 から返すだけで、Log には触れない。
//
// lookup にない版は、proxy に取り込ませてから返す。`direct` で取った利用者も sumdb に照らせるように
// するため（4.7）。proxy は Custom Domain なので、service binding なしに fetch で呼べる
// （proxy は sumdb の Durable Object を束縛しているので、こちらからも束縛すると deploy の順が決まらない）。

import {
  isVersionOf,
  parseVersion,
  proxyPaths,
  type SourcePath,
  sumdbPaths,
  unescapeSourcePath,
  type Version,
} from "@pome-registry/protocol";

export { Log } from "./log.ts";

const TILE = /^tile\/(entries|[0-9]+)\/(x[0-9]{3}\/)*[0-9]{3}(\.p\/([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5]))?$/;

export type ObjectKey = {
  readonly key: string;
  readonly lookup?: { readonly path: SourcePath; readonly version: Version };
};

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const target = objectKey(new URL(request.url).pathname.slice(1));
    if (target === undefined) return text(404, "not found");
    let object = await env.SUMDB.get(target.key);
    if (object === null && target.lookup !== undefined) {
      const failure = await ingest(env, target.lookup.path, target.lookup.version);
      if (failure !== undefined) return failure;
      object = await env.SUMDB.get(target.key);
      // 記録したが、R2 への公開が遅れている。Log が alarm で追いかける。
      if (object === null) return text(404, "recorded but not yet published, retry later", 5);
    }
    if (object === null) return text(404, "not found");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
} satisfies ExportedHandler<Env>;

// proxy に `.info` を求めて取り込ませる。取り込めたら undefined、だめならそのまま返す応答。
async function ingest(env: Env, path: SourcePath, version: Version): Promise<Response | undefined> {
  const res = await fetch(`${env.PROXY_URL}/${proxyPaths.info(path, version)}`);
  if (res.ok) return undefined;
  const message = (await res.text()).trim();
  // 404 と 410 は版そのものの問題なので、proxy の理由をそのまま渡す。ほかは一時的な失敗として 502。
  if (res.status === 404 || res.status === 410) return text(res.status, message, 60);
  return text(502, `proxy answered ${res.status}: ${message}`, 0);
}

// URL の path を R2 のキーにする。知らない形は undefined。
export function objectKey(path: string): ObjectKey | undefined {
  if (path === sumdbPaths.checkpoint()) return { key: path };
  if (TILE.test(path)) return { key: path };
  if (path.startsWith("lookup/")) {
    const rest = path.slice("lookup/".length);
    const at = rest.lastIndexOf("@");
    if (at < 0) return undefined;
    try {
      const lookup = { path: unescapeSourcePath(rest.slice(0, at)), version: parseVersion(rest.slice(at + 1)) };
      if (!isVersionOf(lookup.path, lookup.version)) return undefined;
      const key = sumdbPaths.lookup(lookup.path, lookup.version);
      return key === path ? { key, lookup } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function text(status: number, message: string, maxAge = 60): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}
