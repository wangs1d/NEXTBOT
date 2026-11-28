import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { LocalRerankerEngine } from "./local-reranker-engine.js";
import { LOCAL_RERANKER_MODEL_ID } from "./local-reranker-engine.js";

export type LocalRerankerEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENTS = 20;
const REQUEST_TIMEOUT_MS = 30_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function startLocalRerankerServer(
  getEngine: () => LocalRerankerEngine | null,
): Promise<LocalRerankerEndpoint> {
  const apiKey = `local-${randomBytes(12).toString("hex")}`;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(error) } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const engine = getEngine();
    if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
      sendJson(res, 200, {
        ok: engine !== null,
        model: LOCAL_RERANKER_MODEL_ID,
        maxSequenceLength: engine?.maxSequenceLength ?? 0,
      });
      return;
    }
    if (req.method !== "POST" || !/^\/(v1\/)?rerank$/.test(url)) {
      sendJson(res, 404, { error: { message: "not found" } });
      return;
    }
    if ((req.headers.authorization ?? "") !== `Bearer ${apiKey}`) {
      sendJson(res, 401, { error: { message: "unauthorized" } });
      return;
    }
    if (!engine) {
      sendJson(res, 503, { error: { message: "reranker engine warming up" } });
      return;
    }

    const parsed = JSON.parse(await readBody(req)) as { query?: unknown; documents?: unknown };
    const query = parsed.query;
    const documents = parsed.documents;
    if (typeof query !== "string" || !query.trim() || query.length > 4_000) {
      sendJson(res, 400, { error: { message: "query must be a non-empty string" } });
      return;
    }
    if (
      !Array.isArray(documents) ||
      documents.length === 0 ||
      documents.length > MAX_DOCUMENTS ||
      documents.some((document) => typeof document !== "string" || !document.trim() || document.length > 16_000)
    ) {
      sendJson(res, 400, { error: { message: `documents must contain 1-${MAX_DOCUMENTS} non-empty strings` } });
      return;
    }

    const scores = await engine.rerank(query, documents as string[]);
    sendJson(res, 200, {
      object: "list",
      model: LOCAL_RERANKER_MODEL_ID,
      data: scores.map((score, index) => ({ index, score })),
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    model: LOCAL_RERANKER_MODEL_ID,
  };
}
