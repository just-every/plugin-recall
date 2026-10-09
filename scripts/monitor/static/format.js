// Number, time and wording helpers. No data of its own.
export const int = (n) => Number(n).toLocaleString();

export function usd(x) {
  if (x === null || x === undefined) return "";
  if (x === 0) return "$0";
  return x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
}

export function dur(ms) {
  if (ms === null || ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export const score = (x) => (typeof x === "number" ? x.toFixed(2) : "–");
export const bar = (x) => String(Number(Number(x).toFixed(4)));

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Local time of day; with the date when it is not today. */
export function clock(iso, now = new Date()) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return sameDay(d, now) ? t : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}`;
}

export const localHour = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function ago(iso, nowMs = Date.now()) {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

export const clip = (text, n) => {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
};

export const sourceName = (src) => ({ file: "config.json", env: "environment", default: "built-in default" })[src] ?? String(src ?? "?");
export const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : "–");

/** A transcript source "<path>:L<line>" with the home dir written as "~". `home` is the monitor's own home dir (the snapshot's `homeDir`). */
export const srcLabel = (src, home = "") => {
  const s = String(src ?? "");
  const h = String(home ?? "").replace(/[\\/]+$/, "");
  return h && s.startsWith(`${h}/`) ? `~${s.slice(h.length)}` : s;
};
