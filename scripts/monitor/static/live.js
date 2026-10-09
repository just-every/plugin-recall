// The connection to the monitor server: one snapshot to start (and again after any gap), then Server-Sent Events. The server sends a heartbeat
// every 15 s; no sign of life for 40 s means the connection is dropped and re-opened.
import { setConn, setSnapshot, setSummary, store, upsertTurn } from "./store.js";

const STALL_MS = 40_000;
let source = null;
let lastBeat = 0;
let loading = false;
let queued = [];
let retry = null;

export async function loadSnapshot() {
  loading = true;
  try {
    const res = await fetch(`/api/snapshot?hours=${encodeURIComponent(store.filters.hours)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`);
    setSnapshot(await res.json());
  } catch (e) {
    setConn("offline", `Cannot load data: ${e.message}`);
  } finally {
    loading = false;
    const pending = queued;
    queued = [];
    for (const fn of pending) fn();
  }
}

// Events that arrive while a snapshot is being fetched are applied after it, so an older snapshot never overwrites a newer line.
const apply = (fn) => (loading ? queued.push(fn) : fn());
const parse = (e) => JSON.parse(e.data);

export function connect() {
  clearTimeout(retry);
  source?.close();
  source = new EventSource("/api/events");
  source.addEventListener("hello", () => { lastBeat = Date.now(); setConn("live", "Live"); loadSnapshot(); });
  source.addEventListener("line", (e) => { lastBeat = Date.now(); const d = parse(e); apply(() => upsertTurn(d.turn)); });
  source.addEventListener("summary", (e) => { lastBeat = Date.now(); const d = parse(e); apply(() => setSummary(d)); });
  source.addEventListener("reset", () => { loadSnapshot(); });
  source.addEventListener("heartbeat", (e) => {
    lastBeat = Date.now();
    if (store.conn.state !== "live") setConn("live", "Live");
    // the UTC day rolled over: today's counters and the spend chart belong to a new day, which only a fresh snapshot has
    if (store.summary && parse(e).day !== store.summary.day) loadSnapshot();
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      setConn("offline", "Offline");
      retry = setTimeout(connect, 2000);
    } else {
      setConn("retry", "Reconnecting");
    }
  };
}

export function watchConnection() {
  setInterval(() => {
    if (store.conn.state === "live" && Date.now() - lastBeat > STALL_MS) {
      setConn("stalled", "Stalled, no heartbeat");
      connect();
    }
  }, 5000);
}
