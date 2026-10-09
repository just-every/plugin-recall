// The live feed: turn cards newest first, with runs of pure skips collapsed. Cards are kept between renders and only rebuilt when their
// content changed, so a new turn slides in without the rest of the list flickering.
import { h, replace } from "./dom.js";
import { ago, clip, clock, dur, usd } from "./format.js";
import { feedItems, matches, windowTurns } from "./selectors.js";
import { select, store } from "./store.js";

const feedEl = document.getElementById("feed");
const emptyEl = document.getElementById("empty");
const cache = new Map(); // key -> {el, version}
const expanded = new Set(); // run keys the user opened

const GLYPH = { injected: "◆", blocked: "▲", audited: "◇", error: "✕", capped: "!", empty: "○", skip: "–" };

function halfRow(label, half) {
  if (!half) return h("div", { class: "half" }, h("span", { class: "which" }, label), h("span", { class: "chip quiet", "data-glyph": "–" }, "Not in the log for this period"));
  const facts = [dur(half.latencyMs), half.costUsd === null ? "" : usd(half.costUsd)].filter(Boolean).join(" · ");
  return h("div", { class: "half", title: half.detail },
    h("span", { class: "which" }, label),
    h("span", { class: `chip ${half.tone}`, "data-glyph": GLYPH[half.kind] ?? "" }, half.label),
    facts ? h("span", { class: "cost" }, facts) : null);
}

function kindOf(t) {
  const kinds = [t.prompt?.kind, t.stop?.kind];
  for (const k of ["blocked", "error", "capped", "injected"]) if (kinds.includes(k)) return k;
  return "quiet";
}

function buildCard(t, { compact }) {
  const select_ = () => select(t.id);
  const summary = `${clock(t.ts)}, ${t.host ?? "unknown host"}${t.project ? `, ${t.project}` : ""}. Prompt: ${t.prompt?.label ?? "none"}.${t.stop ? ` Stop (old Recall): ${t.stop.label}.` : ""}`;
  return h("article", {
    class: `card${compact ? " compact" : ""}`, role: "button", tabindex: 0, "data-id": t.id, "data-kind": kindOf(t),
    "aria-current": store.selectedId === t.id ? "true" : null, "aria-label": summary,
    onclick: select_,
    onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); select_(); } },
  },
    h("div", { class: "meta" },
      h("time", { datetime: t.ts, title: t.ts }, clock(t.ts)),
      t.host ? h("span", { class: "pill host" }, t.host) : null,
      t.home ? h("span", { class: "pill" }, t.home) : null,
      t.project ? h("span", { class: "project" }, t.project) : null,
      t.followUps ? h("span", { class: "pill" }, `+${t.followUps} follow-up Stop${t.followUps === 1 ? "" : "s"}`) : null,
      h("span", { class: "age", "data-ts": t.ts }, ago(t.ts))),
    t.query ? h("p", { class: "query" }, h("span", { class: "you" }, "You:"), clip(t.query, 160)) : null,
    h("div", { class: "halves" }, halfRow("Prompt", t.prompt), t.stop ? halfRow("Stop", t.stop) : null));
}

function groupText(turns) {
  const counts = new Map();
  for (const t of turns) counts.set(t.skipGroupLabel, (counts.get(t.skipGroupLabel) ?? 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  const text = rows.length === 1 ? rows[0][0] : rows.slice(0, 3).map(([label, n]) => `${label} (${n})`).join(", ") + (rows.length > 3 ? `, +${rows.length - 3} more` : "");
  return `${turns.length} skipped turn${turns.length === 1 ? "" : "s"} · ${text}`;
}

function buildRun(key, turns) {
  const open = expanded.has(key);
  const toggle = () => { if (expanded.has(key)) expanded.delete(key); else expanded.add(key); renderFeed(); };
  return h("div", { class: "run" },
    h("button", { type: "button", "aria-expanded": String(open), onclick: toggle }, h("span", { class: "caret", "aria-hidden": "true" }, open ? "▾" : "▸"), h("span", null, groupText(turns))),
    open ? h("ul", null, ...turns.map((t) => h("li", {
      tabindex: 0, role: "button", "aria-current": store.selectedId === t.id ? "true" : null, onclick: () => select(t.id),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(t.id); } },
    }, h("time", { datetime: t.ts }, clock(t.ts)), t.host ? h("span", { class: "pill host" }, t.host) : null, t.project ? h("span", null, t.project) : null,
    h("span", null, (t.prompt ?? t.stop).label.replace(/^Skipped: /, ""))))) : null);
}

function reconcile(items) {
  const keep = new Set();
  let prev = null;
  for (const item of items) {
    keep.add(item.key);
    let rec = cache.get(item.key);
    if (!rec) {
      rec = { el: item.build(), version: item.version };
      if (store.loaded && item.fresh) rec.el.classList.add("enter");
      cache.set(item.key, rec);
    } else if (rec.version !== item.version) {
      const el = item.build();
      if (item.touched) el.classList.add("touched");
      rec.el.replaceWith(el);
      rec.el = el;
      rec.version = item.version;
    }
    const at = prev ? prev.nextSibling : feedEl.firstChild;
    if (rec.el !== at) feedEl.insertBefore(rec.el, at);
    prev = rec.el;
  }
  for (const [key, rec] of cache) if (!keep.has(key)) { rec.el.remove(); cache.delete(key); }
}

export function renderFeed() {
  const nowMs = Date.now();
  const all = windowTurns(nowMs);
  const turns = all.filter((t) => matches(t, store.filters));
  const showSkips = store.filters.showSkips;
  const items = feedItems(turns, showSkips).map((it) => {
    if (it.kind === "run") {
      const key = `run:${it.turns.at(-1).id}`;
      const open = expanded.has(key);
      return { key, version: `${it.turns.length}|${open}|${open ? store.selectedId : ""}`, build: () => buildRun(key, it.turns), fresh: true };
    }
    const t = it.turn;
    const compact = showSkips && t.skip;
    return {
      key: `card:${t.id}`, version: `${t.updated}|${t.followUps}|${compact}|${store.selectedId === t.id}`,
      build: () => buildCard(t, { compact }), fresh: store.fresh.has(t.id), touched: store.touched.has(t.id),
    };
  });
  reconcile(items);
  store.fresh.clear();
  store.touched.clear();

  const none = turns.length === 0;
  emptyEl.hidden = !none || !store.loaded;
  if (none && store.loaded) {
    const filtered = all.length > 0;
    replace(emptyEl, filtered ? "No turn matches these filters." : `No hook activity in this period. Recall writes one line to ${store.dataDir}/logs each time a hook fires in an installed home; new turns appear here as they happen.`);
  }
}

/** Keep the "3 min ago" labels current between data events. */
export function tickFeed() {
  const nowMs = Date.now();
  for (const el of feedEl.querySelectorAll(".age[data-ts]")) el.textContent = ago(el.dataset.ts, nowMs);
}
