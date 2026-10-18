// sumdb の読みの口。checkpoint、lookup、tile を R2 から返すだけで、Log には触れない。

import { parseVersion, sumdbPaths, unescapeSourcePath } from "@pome-registry/protocol";

export { Log } from "./log.ts";

const TILE = /^tile\/(entries|[0-9]+)\/(x[0-9]{3}\/)*[0-9]{3}(\.p\/([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5]))?$/;

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const key = objectKey(new URL(request.url).pathname.slice(1));
    if (key === undefined) return notFound();
    const object = await env.SUMDB.get(key);
    if (object === null) return notFound();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
} satisfies ExportedHandler<Env>;

// URL の path を R2 のキーにする。知らない形は undefined。
export function objectKey(path: string): string | undefined {
  if (path === sumdbPaths.checkpoint()) return path;
  if (TILE.test(path)) return path;
  if (path.startsWith("lookup/")) {
    const rest = decodeURIComponent(path.slice("lookup/".length));
    const at = rest.lastIndexOf("@");
    if (at < 0) return undefined;
    try {
      const key = sumdbPaths.lookup(unescapeSourcePath(rest.slice(0, at)), parseVersion(rest.slice(at + 1)));
      return key === `lookup/${rest}` ? key : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function notFound(): Response {
  return new Response("not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}
