/** Read-only loopback preview URLs, serving only the attested self-contained HTML. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { FactoryError } from "../errors.ts";
import { renderPreview } from "./preview.ts";
import type { ScrumRun } from "./run-journal.ts";
const previews = new Map<string, { server: Server; url: string; fingerprint: string }>();
export async function servePreview(root: string, run: ScrumRun, options: { subpath?: string; port?: number } = {}) {
  const preview = renderPreview(root, run, options.subpath);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FactoryError("invalid-preview-port", "port must be 0..65535");
  const key = `${root}:${run.runId}`, fingerprint = `${preview.digest}:${options.subpath ?? ""}:${port}`;
  const existing = previews.get(key);
  if (existing?.fingerprint === fingerprint) return { ...preview, url: existing.url };
  if (existing) { existing.server.close(); previews.delete(key); }
  const server = createServer((request, response) => {
    if (request.url !== "/" || !["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Connection": "close" });
    response.end(request.method === "HEAD" ? undefined : preview.html);
  });
  server.on("connection", socket => socket.unref());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new FactoryError("preview-unavailable", "loopback listener unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  previews.set(key, { server, url, fingerprint });
  server.unref();
  const expiry = setTimeout(() => { if (previews.get(key)?.server === server) previews.delete(key); server.close(); }, 15 * 60_000);
  expiry.unref();
  server.once("close", () => clearTimeout(expiry));
  return { ...preview, url };
}
