// The monitor's HTTP server on a temp fixture data dir: snapshot, live push over SSE, read-only, loopback-only, static page. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMonitorServer } from "../scripts/monitor/server.mjs";
import { NOW, fixtureLines, jsonl, seedMonitorData, treeStamp } from "./monitor-fixture.mjs";
import { tmpDir } from "./helpers.mjs";

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "monitor", "static");

async function start({ env = {}, config, pollMs = 20, heartbeatMs = 60_000, clock = () => NOW, seed = true } = {}) {
  const dataDir = tmpDir("monitor-data");
  if (seed) seedMonitorData(dataDir, config === undefined ? {} : { config });
  const monitor = createMonitorServer({ dataDir, env: { RECALL_DATA: dataDir, ...env }, port: 0, pollMs, heartbeatMs, now: clock });
  const address = await monitor.listen();
  const base = address.url.replace(/\/$/, "");
  return { dataDir, monitor, base, address, json: (p) => fetch(base + p).then((r) => r.json()), close: () => monitor.close() };
}

/** Server-Sent Events client: every event received so far, and a way to wait for the next matching one. */
function sse(url) {
  const events = [];
  const waiters = [];
  let buf = "";
  const req = http.get(url, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = /^event: (.*)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (!name) continue;
        events.push({ name, data: data ? JSON.parse(data) : null });
        for (const w of [...waiters]) w();
      }
    });
  });
  req.on("error", () => {});
  return {
    events,
    close: () => req.destroy(),
    waitFor(from, name, pred = () => true, ms = 4000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = events.slice(from).find((e) => e.name === name && pred(e.data));
          if (hit) { waiters.splice(waiters.indexOf(check), 1); clearTimeout(timer); resolve(hit.data); }
        };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error(`no ${name} event within ${ms} ms; got ${events.slice(from).map((e) => e.name).join(",")}`)); }, ms);
        waiters.push(check);
        check();
      });
    },
  };
}

const today = (dataDir) => path.join(dataDir, "logs", "turns-2026-10-08.jsonl");
const turnBy = (snap, pred) => snap.turns.find(pred);

test("snapshot: the fixture's turns are paired, labelled and newest first; spend, caps, index and counters come from the data", async () => {
  const s = await start();
  try {
    const snap = await s.json("/api/snapshot");
    assert.equal(snap.hours, 24);
    assert.equal(snap.dataDir, s.dataDir);
    const t = snap.turns;
    assert.equal(t.length, 10, "T0 (yesterday, 3.5 h ago) .. T8 and the crash line");
    assert.deepEqual(t.map((x) => x.ts), [...t.map((x) => x.ts)].sort().reverse(), "newest first");

    const t1 = turnBy(snap, (x) => x.session_id === "sess-1");
    assert.deepEqual([t1.prompt.label, t1.stop.label, t1.host, t1.home, t1.project, t1.skip], ["Injected 2", "Audited 5 · best 0.77 / 0.9", "claude", "~/.claude_work", "project-1", false]);
    assert.equal(t1.query, "We should add a fallback path when the draft runs duplicate");
    assert.equal(t1.prompt.latencyMs, 1840);
    assert.equal(t1.prompt.costUsd, 0.0043 + 1e-6);
    const legacy = turnBy(snap, (x) => x.session_id === "sess-old");
    assert.deepEqual([legacy.prompt.label, legacy.host, legacy.home, legacy.project, legacy.cwd, legacy.query], ["Injected 1", "claude", null, null, null, "an old question from yesterday"], "a line from before the origin fields renders, with the origin left blank");
    const t2 = turnBy(snap, (x) => x.session_id === "sess-2");
    assert.deepEqual([t2.prompt.label, t2.stop.label, t2.host, t2.home], ["Nothing above 0.95", "Blocked", "codex", "~/.codex_work"]);
    for (const sess of ["sess-3", "sess-4", "sess-8"]) assert.equal(turnBy(snap, (x) => x.session_id === sess).skip, true, `${sess} is a pure skip`);
    assert.equal(turnBy(snap, (x) => x.session_id === "sess-3").skipGroupLabel, "sub-agent notices");
    assert.equal(turnBy(snap, (x) => x.session_id === "sess-8").skipGroupLabel, "automated sessions");
    const keyless = turnBy(snap, (x) => x.session_id === "sess-5");
    assert.deepEqual([keyless.prompt.label, keyless.stop.label], ["Injected 1", "Audited 3 · best 0.10 / 0.9"], "a prompt and a Stop without turn_key pair by session");
    const stopOnly = turnBy(snap, (x) => x.session_id === "sess-6");
    assert.deepEqual([stopOnly.prompt, stopOnly.stop.label], [null, "Skipped: the final reply was too short to audit"]);
    const failed = turnBy(snap, (x) => x.session_id === "sess-7");
    assert.deepEqual([failed.prompt.label, failed.stop.label, failed.skip], ["Search failed", "Audit failed", false]);
    assert.ok(snap.turns.some((x) => x.prompt?.reason === "hook-crashed" && x.session_id === null), "the crash line is a card of its own");

    const { summary } = snap;
    assert.equal(summary.day, "2026-10-08");
    assert.ok(Math.abs(summary.spend.todayUsd - 0.05) < 1e-12, "today's spend counts only the UTC day");
    assert.ok(Math.abs(summary.spend.totalUsd - 0.06) < 1e-12);
    assert.equal(summary.spend.byHour.length, 24);
    assert.deepEqual([summary.spend.byHour[1], summary.spend.byHour[2], summary.spend.byHour[23]], [0.02, 0.03, 0]);
    assert.deepEqual(summary.caps, { dailyUsd: { value: 5, source: "file" }, totalUsd: { value: 6.34, source: "file" } });
    assert.deepEqual(summary.bars, { promptThreshold: 0.95, stopThreshold: 0.9 });
    assert.deepEqual(summary.index.byHost, { claude: 1, codex: 2 });
    assert.equal(summary.index.statements, 3);
    assert.equal(summary.index.lastIndex.at, new Date(NOW.getTime() - 12 * 60_000).toISOString());
    const c = summary.counters;
    assert.deepEqual([c.fired, c.prompts, c.stops, c.searched, c.injectedTurns, c.injectedStatements, c.audited, c.blocked, c.skipped, c.errors, c.capped], [15, 8, 7, 4, 2, 3, 3, 1, 6, 3, 0], "today's lines only: yesterday's T0 is outside the UTC day");
    assert.equal(c.skippedByReason.find((r) => r.reason === "not-owner-text:agent-completion").count, 2);
    assert.equal(snap.reasons.find((r) => r.reason === "not-owner-text:agent-completion").count, 2);
    assert.deepEqual(summary.sessions.map((x) => x.session_id).sort(), ["sess-1", "sess-2", "sess-3", "sess-4", "sess-5", "sess-6", "sess-7"], "sess-8 is an automated session and not listed");
    assert.equal(summary.sessions.find((x) => x.session_id === "sess-2").project, "project-2");
  } finally { await s.close(); }
});

test("snapshot ?hours= bounds the window; a bad value is a 400, not a guess", async () => {
  const s = await start();
  try {
    assert.equal((await s.json("/api/snapshot?hours=1")).turns.length, 9, "the 3.5 hour old turn is out");
    assert.equal((await s.json("/api/snapshot?hours=6")).turns.length, 10);
    assert.equal((await s.json("/api/snapshot?hours=0.2")).turns.length, 7, "T3 .. T8 and the crash line: the last 12 minutes");
    for (const bad of ["0", "-3", "abc", "9999"]) assert.equal((await fetch(`${s.base}/api/snapshot?hours=${bad}`)).status, 400, bad);
  } finally { await s.close(); }
});

test("caps and their sources: environment beats config.json beats the default; an invalid config is reported, not replaced", async () => {
  const env = await start({ env: { RECALL_DAILY_CAP_USD: "2" } });
  try {
    assert.deepEqual((await env.json("/api/snapshot")).summary.caps, { dailyUsd: { value: 2, source: "env" }, totalUsd: { value: 6.34, source: "file" } });
  } finally { await env.close(); }
  const none = await start({ config: null });
  try {
    const { summary } = await none.json("/api/snapshot");
    assert.deepEqual(summary.caps, { dailyUsd: { value: 1, source: "default" }, totalUsd: { value: null, source: "default" } });
  } finally { await none.close(); }
  const bad = await start({ config: { dailyCapUsd: "five" } });
  try {
    const snap = await bad.json("/api/snapshot");
    assert.match(snap.summary.configError, /ConfigError.*dailyCapUsd/);
    assert.equal(snap.summary.caps, null);
    assert.deepEqual(snap.summary.bars, { promptThreshold: null, stopThreshold: null });
    assert.equal(snap.turns.find((x) => x.session_id === "sess-2").prompt.label, "Nothing above the injection bar", "no guessed bar");
    fs.writeFileSync(path.join(bad.dataDir, "config.json"), JSON.stringify({ dailyCapUsd: 3 }));
    assert.equal((await bad.json("/api/snapshot")).summary.caps.dailyUsd.value, 3, "the file is re-read, no restart needed");
  } finally { await bad.close(); }
});

test("SSE: a new log line is pushed with its paired turn, then a summary; a Stop line joins its prompt's turn", async () => {
  const s = await start();
  const live = sse(`${s.base}/api/events`);
  try {
    const hello = await live.waitFor(0, "hello");
    assert.equal(hello.heartbeatMs, 60_000);
    const from = live.events.length;
    const prompt = { ts: "2026-10-08T02:59:30.000Z", level: "info", event: "prompt", host: "claude", home: "~/.claude_work", cwd: "/x/live", project: "live", transcript: "/x", session_id: "sess-live", turn_key: "turn-live", pipeline: "default", outcome: "injected", query: "a brand new question", candidates: [], injected: ["a", "b", "c"], context: "<recall-context>x</recall-context>", latency_ms: 900, stats: { costUsd: 0.003 } };
    fs.appendFileSync(today(s.dataDir), JSON.stringify(prompt) + "\n");
    const pushed = await live.waitFor(from, "line", (d) => d.line.session_id === "sess-live");
    assert.deepEqual(pushed.line, prompt, "the raw log line itself");
    assert.deepEqual([pushed.turn.prompt.label, pushed.turn.stop, pushed.turn.query, pushed.turn.project], ["Injected 3", null, "a brand new question", "live"]);
    const summary = await live.waitFor(from, "summary", (d) => d.counters.injectedTurns === 3);
    assert.equal(summary.counters.fired, 16);
    assert.ok(summary.sessions.some((x) => x.session_id === "sess-live"));

    const stop = { ...prompt, ts: "2026-10-08T02:59:50.000Z", event: "stop", pipeline: "compose-lean", outcome: "silent", reason: "no-violation-above-threshold", audited: 5, latency_ms: 3000, stats: { audited: 5, top: [{ id: "a", score: 0.77 }], costUsd: 0.07 } };
    delete stop.query; delete stop.candidates; delete stop.injected; delete stop.context;
    const at = live.events.length;
    fs.appendFileSync(today(s.dataDir), JSON.stringify(stop) + "\n");
    const joined = await live.waitFor(at, "line", (d) => d.line.event === "stop" && d.line.session_id === "sess-live");
    assert.equal(joined.turn.id, pushed.turn.id, "same card");
    assert.deepEqual([joined.turn.prompt.label, joined.turn.stop.label], ["Injected 3", "Audited 5 · best 0.77 / 0.9"]);
  } finally { live.close(); await s.close(); }
});

test("SSE: spend updates when the ledger grows; a partial last line is not pushed until it is complete", async () => {
  const s = await start();
  const live = sse(`${s.base}/api/events`);
  try {
    await live.waitFor(0, "hello");
    let at = live.events.length;
    fs.appendFileSync(path.join(s.dataDir, "ledger.jsonl"), JSON.stringify({ ts: "2026-10-08T02:55:00.000Z", experiment: "plugin-recall", endpoint: "/v1/decisions", inputTokens: 1, costUsd: 0.25, requestId: "r9", kind: "billed" }) + "\n");
    const spend = await live.waitFor(at, "summary", (d) => Math.abs(d.spend.todayUsd - 0.3) < 1e-9);
    assert.ok(Math.abs(spend.spend.totalUsd - 0.31) < 1e-9);
    assert.ok(Math.abs(spend.spend.byHour[2] - 0.28) < 1e-9);

    at = live.events.length;
    const line = JSON.stringify({ ts: "2026-10-08T02:59:59.000Z", level: "info", event: "prompt", host: "claude", session_id: "sess-partial", turn_key: "tp", outcome: "silent", reason: "nothing-above-threshold", latency_ms: 5 });
    fs.appendFileSync(today(s.dataDir), line.slice(0, 40));
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!live.events.slice(at).some((e) => e.name === "line"), "half a line is not a line");
    fs.appendFileSync(today(s.dataDir), line.slice(40) + "\n");
    const got = await live.waitFor(at, "line", (d) => d.line.session_id === "sess-partial");
    assert.equal(got.turn.prompt.label, "Nothing above 0.95");
  } finally { live.close(); await s.close(); }
});

test("SSE: a heartbeat arrives on schedule; truncating the log tells the page to reload", async () => {
  const s = await start({ heartbeatMs: 50 });
  const live = sse(`${s.base}/api/events`);
  try {
    await live.waitFor(0, "hello");
    const beat = await live.waitFor(0, "heartbeat");
    assert.equal(beat.day, "2026-10-08");
    const at = live.events.length;
    fs.writeFileSync(today(s.dataDir), jsonl(fixtureLines().slice(1, 3)));
    await live.waitFor(at, "reset");
    const snap = await s.json("/api/snapshot");
    assert.equal(snap.turns.filter((x) => x.session_id === "sess-1").length, 1, "rebuilt from the files: no duplicate card");
    assert.equal(snap.turns.some((x) => x.session_id === "sess-2"), false, "the truncated lines are gone");
  } finally { live.close(); await s.close(); }
});

test("the day rolling over on the server clock: heartbeats name the new day, the next snapshot counts it", async () => {
  const clock = { now: new Date("2026-10-08T23:59:59.000Z") };
  const s = await start({ heartbeatMs: 50, clock: () => clock.now });
  const live = sse(`${s.base}/api/events`);
  try {
    await live.waitFor(0, "hello");
    assert.equal((await s.json("/api/snapshot")).summary.day, "2026-10-08");
    clock.now = new Date("2026-10-09T00:00:30.000Z");
    const next = path.join(s.dataDir, "logs", "turns-2026-10-09.jsonl");
    const at = live.events.length;
    fs.writeFileSync(next, JSON.stringify({ ts: "2026-10-09T00:00:10.000Z", level: "info", event: "prompt", host: "claude", session_id: "sess-new-day", turn_key: "tn", outcome: "silent", reason: "nothing-above-threshold", latency_ms: 5 }) + "\n");
    await live.waitFor(at, "line", (d) => d.line.session_id === "sess-new-day");
    await live.waitFor(at, "heartbeat", (d) => d.day === "2026-10-09");
    const { summary } = await s.json("/api/snapshot");
    assert.deepEqual([summary.day, summary.counters.fired, summary.spend.todayUsd], ["2026-10-09", 1, 0]);
  } finally { live.close(); await s.close(); }
});

test("read-only: serving the page, snapshots and an event stream change nothing under the data dir", async () => {
  const s = await start();
  const before = treeStamp(s.dataDir);
  const live = sse(`${s.base}/api/events`);
  try {
    await live.waitFor(0, "hello");
    await s.json("/api/snapshot");
    await s.json("/api/statements?ids=claude-aaa");
    await fetch(s.base + "/");
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(treeStamp(s.dataDir), before);
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(`${s.base}/api/snapshot`, { method })).status, 405, method);
  } finally { live.close(); await s.close(); }
});

test("loopback only: a non-loopback host is refused at construction; a foreign Host header is refused per request", async () => {
  const dataDir = tmpDir("monitor-data");
  for (const host of ["0.0.0.0", "192.168.1.5", "example.com"]) assert.throws(() => createMonitorServer({ dataDir, host }), /loopback only/);
  const s = await start();
  try {
    assert.equal(s.address.host, "127.0.0.1");
    assert.equal(s.monitor.server.address().address, "127.0.0.1");
    const get = (host) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: s.address.port, path: "/api/snapshot", headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
    });
    assert.equal(await get(`127.0.0.1:${s.address.port}`), 200);
    assert.equal(await get(`localhost:${s.address.port}`), 200);
    assert.equal(await get(`[::1]:${s.address.port}`), 200);
    assert.equal(await get("evil.example.com"), 403, "DNS rebinding: the Host header names another origin");
    assert.equal(await get(`evil.example.com:${s.address.port}`), 403);
  } finally { await s.close(); }
});

test("statements endpoint: only ids that are in the index come back", async () => {
  const s = await start();
  try {
    const { statements } = await s.json("/api/statements?ids=claude-aaa,nope,codex-bbb");
    assert.deepEqual(statements.map((x) => [x.id, x.repo, x.host]), [["claude-aaa", "shared-lib", "claude"], ["codex-bbb", "design-kit", "codex"]]);
    assert.deepEqual((await s.json("/api/statements")).statements, []);
  } finally { await s.close(); }
});

test("an empty data dir is a working, empty monitor: no logs, no ledger, no index", async () => {
  const s = await start({ seed: false });
  try {
    const snap = await s.json("/api/snapshot");
    assert.deepEqual(snap.turns, []);
    assert.deepEqual([snap.summary.spend.todayUsd, snap.summary.spend.totalUsd, snap.summary.index.statements, snap.summary.index.lastIndex], [0, 0, 0, null]);
    assert.deepEqual(snap.summary.caps, { dailyUsd: { value: 1, source: "default" }, totalUsd: { value: null, source: "default" } });
  } finally { await s.close(); }
});

test("static page: served with a strict CSP; every file it pulls in exists; nothing external except Google Fonts", async () => {
  const s = await start();
  try {
    const page = await fetch(s.base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/, "no inline script");
    const html = await page.text();
    assert.match(html, /<title>Recall Monitor<\/title>/);
    const queue = [...html.matchAll(/(?:src|href)="([^":]+\.(?:js|css|svg))"/g)].map((m) => m[1]);
    assert.ok(queue.includes("app.js") && queue.includes("app.css"));
    const seen = new Set();
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      const res = await fetch(`${s.base}/${name}`);
      assert.equal(res.status, 200, `${name} is served`);
      const text = await res.text();
      if (name.endsWith(".js")) for (const m of text.matchAll(/from "\.\/([a-z-]+\.js)"/g)) queue.push(m[1]);
    }
    assert.ok(seen.size >= 10, `modules found: ${[...seen].join(", ")}`);
    assert.equal((await fetch(`${s.base}/nope.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2f..%2fREADME.md`)).status, 404);
    assert.equal((await fetch(`${s.base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/state.mjs`)).status, 404, "only the static folder is served");
  } finally { await s.close(); }
  // external resources: the page may load Google Fonts and nothing else
  for (const name of fs.readdirSync(STATIC)) {
    const text = fs.readFileSync(path.join(STATIC, name), "utf8");
    for (const url of text.match(/https?:\/\/[^\s"')]+/g) ?? []) {
      assert.ok(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url) || url === "http://www.w3.org/2000/svg", `${name} references ${url}`);
    }
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(text), `${name} must not build markup from strings`);
  }
});
