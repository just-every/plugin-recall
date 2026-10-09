// The Recall Monitor HTTP server. Loopback only; it reads the data dir and serves the page, never writes, never calls an API and never
// opens a browser.
//   GET /                   the page (static files from ./static)
//   GET /api/snapshot       the turns of the last ?hours= (default 24, at most 168), spend, caps, index stats, per-reason counts
//   GET /api/events         Server-Sent Events: `line` for every new log line (with its turn), `summary`, `reset`, `heartbeat` (with the server's UTC day) every 15 s
//   GET /api/statements?ids=a,b   the indexed statements with these ids (for the Stop audit's candidates)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMonitorState } from "./state.mjs";

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
export const MAX_HOURS = 168;
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "connect-src 'self'", "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

export const isLoopback = (host) => LOOPBACK.has(host);

/** The Host header must name this machine: a page on another origin that rebinds its DNS name to 127.0.0.1 is refused. */
function hostAllowed(header) {
  if (!header) return false;
  const name = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : header.split(":")[0];
  return LOOPBACK.has(name);
}

/**
 * @param {{dataDir: string, env?: object, host?: string, port?: number, pollMs?: number, heartbeatMs?: number, now?: () => Date, log?: (s: string) => void}} o
 */
export function createMonitorServer({ dataDir, env = process.env, host = "127.0.0.1", port = 4777, pollMs = 500, heartbeatMs = 15_000, now = () => new Date(), log = () => {} }) {
  if (!isLoopback(host)) throw new Error(`recall monitor binds to loopback only (127.0.0.1); refusing --host ${host}`);
  const state = createMonitorState({ dataDir, env, now, onProblem: (m) => log(`[recall monitor] ${m}\n`) });
  const clients = new Set();
  let pollTimer = null;
  let beatTimer = null;

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };

  state.subscribe((e) => {
    if (e.type === "line") broadcast("line", { line: e.line, turn: e.turn });
    else if (e.type === "summary") broadcast("summary", e.summary);
    else if (e.type === "reset") broadcast("reset", { at: now().toISOString() });
  });

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  function serveStatic(req, res, name) {
    const ext = path.extname(name);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !TYPES[ext]) return json(res, 404, { error: "not found" });
    let body;
    try { body = fs.readFileSync(path.join(STATIC_DIR, name)); } catch (e) { if (e.code === "ENOENT") return json(res, 404, { error: "not found" }); throw e; }
    res.writeHead(200, { "content-type": TYPES[ext], "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function events(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 2000\n\n");
    send(res, "hello", { now: now().toISOString(), heartbeatMs });
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/snapshot") {
      const hours = url.searchParams.has("hours") ? Number(url.searchParams.get("hours")) : 24;
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) return json(res, 400, { error: `hours must be a number in (0, ${MAX_HOURS}]` });
      return json(res, 200, state.snapshot({ hours }));
    }
    if (url.pathname === "/api/events") return events(req, res);
    if (url.pathname === "/api/statements") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 50);
      return json(res, 200, { statements: state.statements(ids) });
    }
    if (url.pathname === "/") return serveStatic(req, res, "index.html");
    return serveStatic(req, res, url.pathname.slice(1));
  }

  const server = http.createServer((req, res) => {
    try {
      if (!hostAllowed(req.headers.host)) return json(res, 403, { error: "this server answers only to localhost" });
      if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("allow", "GET, HEAD"); return json(res, 405, { error: "read-only" }); }
      route(req, res);
    } catch (e) {
      log(`[recall monitor] ${req.url}: ${e.stack ?? e}\n`);
      if (!res.headersSent) json(res, 500, { error: String(e.message) });
      else res.end();
    }
  });

  return {
    server,
    state,
    /** Read what is already on disk, then listen. @returns {Promise<{host: string, port: number, url: string}>} */
    listen() {
      state.poll({ replay: true });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          pollTimer = setInterval(() => state.poll(), pollMs);
          beatTimer = setInterval(() => broadcast("heartbeat", { now: now().toISOString(), day: now().toISOString().slice(0, 10) }), heartbeatMs);
          const addr = server.address();
          resolve({ host, port: addr.port, url: `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}/` });
        });
      });
    },
    close() {
      clearInterval(pollTimer);
      clearInterval(beatTimer);
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  };
}
