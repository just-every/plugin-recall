// The top bar: connection, index, and the two spend meters.
import { h, replace } from "./dom.js";
import { ago, int, localHour, sourceName, usd } from "./format.js";
import { store } from "./store.js";

const connEl = document.getElementById("conn");
const indexEl = document.getElementById("index");
const metersEl = document.getElementById("meters");
const bannerEl = document.getElementById("banner");

function meter({ title, spent, cap, source, capName, resets }) {
  const pct = cap ? (spent / cap) * 100 : null;
  const state = pct === null ? "none" : pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
  const fill = h("div", { class: "fill" });
  fill.style.width = `${Math.min(100, pct ?? 0)}%`;
  return h("div", { class: "meter", "data-state": state },
    h("div", { class: "meter-head" }, h("span", null, title), h("b", null, usd(spent)), h("span", null, cap === null ? `no ${capName} cap set` : `of ${usd(cap)} ${capName} cap`)),
    h("div", { class: "track", role: "meter", "aria-label": `${title} spend`, "aria-valuemin": 0, "aria-valuemax": cap ?? spent, "aria-valuenow": spent, "aria-valuetext": cap === null ? `${usd(spent)}, no cap` : `${usd(spent)} of ${usd(cap)}` }, fill),
    h("div", { class: "meter-foot" },
      pct === null ? null : h("span", { class: "state" }, state === "over" ? "Cap reached: the hooks are silent" : state === "warn" ? `${Math.round(pct)}% used, near the cap` : `${Math.round(pct)}% used`),
      h("span", null, source ? `cap from ${sourceName(source)}` : null, resets ? ` · resets ${resets} local` : null)));
}

export function renderTopbar() {
  const { conn, summary } = store;
  connEl.dataset.state = conn.state;
  connEl.querySelector(".conn-text").textContent = conn.text;

  if (!summary) { replace(metersEl); replace(indexEl); return; }
  const { spend, caps, index, configError, problems, badLines } = summary;
  const resets = localHour(Date.parse(`${spend.day}T00:00:00Z`) + 86_400_000);
  replace(metersEl,
    meter({ title: "Today", spent: spend.todayUsd, cap: caps?.dailyUsd.value ?? null, source: caps?.dailyUsd.source, capName: "daily", resets }),
    meter({ title: "All time", spent: spend.totalUsd, cap: caps?.totalUsd.value ?? null, source: caps?.totalUsd.source, capName: "total" }));

  const hosts = Object.entries(index.byHost).map(([k, v]) => `${k} ${int(v)}`).join(", ");
  replace(indexEl, h("span", { title: hosts ? `By host: ${hosts}` : null }, h("b", null, int(index.statements)), " statements indexed"),
    " · ", h("span", { "data-ts": index.lastIndex?.at ?? "", class: "last-index" }, index.lastIndex?.at ? `last indexed ${ago(index.lastIndex.at)}` : "never indexed"));

  const notes = [];
  if (configError) notes.push(h("p", { class: "b" }, h("b", null, "Configuration problem. "), `The caps and bars shown may be wrong until it is fixed: ${configError}`));
  for (const p of problems) notes.push(h("p", { class: "b" }, h("b", null, "Cannot read data. "), p));
  if (badLines) notes.push(h("p", { class: "b" }, h("b", null, `${badLines} unreadable log line${badLines === 1 ? "" : "s"} skipped.`)));
  bannerEl.hidden = notes.length === 0;
  replace(bannerEl, ...notes);
}

/** Keep "indexed N min ago" honest between data events. */
export function tickTopbar() {
  const el = document.querySelector(".last-index");
  if (el?.dataset.ts) el.textContent = `last indexed ${ago(el.dataset.ts)}`;
}
