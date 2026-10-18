// ingester の HTTP の口。POST /v1/ingest だけを受け、proxy の Worker が付けた HMAC の署名を確かめる。
// 公開ホスト名は持たず、Cloudflare Tunnel（Workers VPC Service）の先に置く。

import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  INGEST_PART_ARCHIVE,
  INGEST_PART_META,
  INGEST_PATH,
  importSigningKey,
  verifyRequest,
} from "@pome-registry/protocol";
import { ingest, type IngestOptions } from "./ingest.ts";

export type ServerOptions = IngestOptions & {
  readonly secret: string;
  readonly maxConcurrency: number;
};

const MAX_BODY_BYTES = 4096;

export function createIngester(options: ServerOptions): Server {
  const key = importSigningKey(options.secret);
  let running = 0;

  return createServer((req, res) => {
    const send = (status: number, body: string | Buffer, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    const handle = async () => {
      const url = new URL(req.url ?? "/", "http://ingester");
      if (url.pathname === "/healthz") return send(200, "ok\n", "text/plain");
      if (url.pathname !== INGEST_PATH) return send(404, "not found\n", "text/plain");
      if (req.method !== "POST") return send(405, "method not allowed\n", "text/plain");

      const body = await readBody(req);
      if (body === undefined) return send(413, "body too large\n", "text/plain");
      const headers = { get: (name: string) => headerValue(req, name) };
      if (!(await verifyRequest(await key, "POST", INGEST_PATH, body, headers))) {
        return send(401, "bad signature\n", "text/plain");
      }
      if (running >= options.maxConcurrency) return send(503, "busy\n", "text/plain");

      running++;
      try {
        let input: unknown;
        try {
          input = JSON.parse(new TextDecoder().decode(body));
        } catch {
          input = undefined;
        }
        const result = await ingest(input, options);
        if (!result.ok) return send(result.status, JSON.stringify(result.body));

        const form = new FormData();
        form.set(INGEST_PART_META, JSON.stringify(result.meta));
        form.set(INGEST_PART_ARCHIVE, new Blob([result.archive.slice().buffer as ArrayBuffer], { type: "application/gzip" }), "archive.tar.gz");
        const encoded = new Response(form);
        send(200, Buffer.from(await encoded.arrayBuffer()), encoded.headers.get("content-type")!);
      } finally {
        running--;
      }
    };
    handle().catch((e: unknown) => {
      console.error(e);
      if (!res.headersSent) send(500, "internal error\n", "text/plain");
    });
  });
}

function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  return typeof v === "string" ? v : null;
}
