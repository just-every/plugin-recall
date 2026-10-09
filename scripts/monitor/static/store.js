// The page's state: the turns of the window, the latest summary, the filters. Components subscribe and re-render; renders are coalesced to
// one per animation frame.
const FILTER_KEY = "recall-monitor:filters";
const subscribers = new Set();
let scheduled = false;

function loadFilters() {
  const base = { host: "", home: "", hours: 24, showSkips: false, q: "" };
  try { return { ...base, ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") }; } catch { return base; }
}

export const store = {
  turns: new Map(),
  summary: null,
  reasons: [],
  dataDir: "",
  homeDir: "",
  loaded: false,
  filters: loadFilters(),
  selectedId: null,
  conn: { state: "connecting", text: "Connecting" },
  fresh: new Set(), // ids that arrived live after the first load: they slide in
  touched: new Set(), // ids whose card changed live: they flash once
};

export function subscribe(fn) { subscribers.add(fn); }

export function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; for (const fn of subscribers) fn(store); });
}

export function setFilters(patch) {
  Object.assign(store.filters, patch);
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(store.filters)); } catch { /* private window: the filters just do not persist */ }
  notify();
}

export function setSnapshot(snap) {
  store.turns = new Map(snap.turns.map((t) => [t.id, t]));
  store.summary = snap.summary;
  store.reasons = snap.reasons;
  store.dataDir = snap.dataDir;
  store.homeDir = snap.homeDir ?? "";
  store.loaded = true;
  store.fresh.clear();
  store.touched.clear();
  notify();
}

export function upsertTurn(turn) {
  const existed = store.turns.has(turn.id);
  store.turns.set(turn.id, turn);
  if (existed) store.touched.add(turn.id); else store.fresh.add(turn.id);
  notify();
}

export function setSummary(summary) { store.summary = summary; notify(); }
export function setConn(state, text) { store.conn = { state, text }; notify(); }
export function select(id) { store.selectedId = id; notify(); }
