// The side column: today's counters, spend by hour, active sessions, the index. The same counters also fill the one-line strip that stands in
// for the column on narrow screens.
import { spendChart, peakText } from "./chart.js";
import { h, replace } from "./dom.js";
import { ago, clip, int, localHour, srcLabel } from "./format.js";
import { ACTIVE_MS } from "./selectors.js";
import { store } from "./store.js";

const sideEl = document.getElementById("side");
const stripEl = document.getElementById("strip");
const SHOWN_REASONS = 8;

function counterList(c) {
  const rows = [
    { n: c.fired, label: "hooks fired" },
    { n: c.searched, label: "searched" },
    { n: c.injectedTurns, label: c.injectedStatements ? `injected (${int(c.injectedStatements)} statements)` : "injected" },
    { n: c.skipped, label: "skipped" },
    { n: c.lookedUp ?? 0, label: "context lookups by agents" },
  ];
  // The Stop hook is gone (v2); lines it wrote on earlier days still count when they fall on the day shown.
  if (c.audited) rows.splice(3, 0, { n: c.audited, label: "audited at Stop (old)" });
  if (c.blocked) rows.splice(4, 0, { n: c.blocked, label: "blocked (old)", alert: true });
  if (c.errors) rows.push({ n: c.errors, label: "errors", alert: true });
  if (c.capped) rows.push({ n: c.capped, label: "stopped by the cap", alert: true });
  return rows;
}

function strip(c) {
  const parts = counterList(c).flatMap((r, i) => [i ? " · " : "", h("b", null, int(r.n)), ` ${r.label}`]);
  replace(stripEl, h("span", null, "Today: "), ...parts);
}

const tag = (event) => h("em", null, event);

export function renderSide() {
  const { summary } = store;
  if (!summary) { replace(sideEl); replace(stripEl); return; }
  const { counters: c, spend, index } = summary;
  const sessions = summary.sessions.filter((x) => Date.now() - Date.parse(x.last) <= ACTIVE_MS);
  strip(c);
  const resets = localHour(Date.parse(`${spend.day}T00:00:00Z`) + 86_400_000);
  const reasons = c.skippedByReason;

  const today = h("section", { class: "panel" },
    h("h2", null, "Today"),
    h("p", { class: "note" }, `UTC day ${c.day}, the day the spend cap counts; it rolls over at ${resets} local.`),
    h("div", { class: "counters" }, ...counterList(c).map((r) => h("div", { class: `counter${r.alert ? " alert" : ""}` }, h("b", null, int(r.n)), h("span", null, r.label)))),
    h("p", { class: "subhead" }, "Skipped, by reason"),
    reasons.length
      ? h("ul", { class: "reasons" }, ...reasons.slice(0, SHOWN_REASONS).map((r) => h("li", null, h("span", { class: "n" }, int(r.count)), h("span", { class: "what" }, tag(r.event), r.label))),
        reasons.length > SHOWN_REASONS ? h("li", null, h("span", { class: "n" }, ""), h("span", { class: "what" }, `${reasons.length - SHOWN_REASONS} more reasons`)) : null)
      : h("p", { class: "note" }, "Nothing skipped today."));

  const chart = h("section", { class: "panel" },
    h("h2", null, "Spend by hour"),
    h("p", { class: "note" }, "Today's cap day, hours in local time. Highlighted: the current hour."),
    spendChart(spend.byHour, spend.day, Date.now()),
    h("p", { class: "note" }, peakText(spend.byHour, spend.day)));

  const live = h("section", { class: "panel" },
    h("h2", null, "Active sessions"),
    h("p", { class: "note" }, "A hook fired in the last 30 minutes."),
    sessions.length
      ? h("ul", { class: "sessions" }, ...sessions.map((x) => h("li", null,
        h("div", { class: "s-main" }, h("b", null, x.project ?? "unknown project"), x.host ? h("span", { class: "pill host" }, x.host) : null, x.home ? h("span", { class: "pill" }, x.home) : null),
        h("div", { class: "sub" }, `last hook ${ago(x.last)} · ${x.lines} hook line${x.lines === 1 ? "" : "s"}`))))
      : h("p", { class: "note" }, "No interactive session in the last 30 minutes."));

  const looked = summary.lookups ?? [];
  const lookups = h("section", { class: "panel" },
    h("h2", null, "Agent looked up context"),
    h("p", { class: "note" }, `${int(c.lookedUp ?? 0)} today: an agent ran recall show to read the conversation around a recalled statement.`),
    looked.length
      ? h("ul", { class: "sessions" }, ...looked.map((x) => h("li", { title: x.src ?? x.statement_id },
        h("div", { class: "s-main" }, h("b", null, x.project ?? "unknown project"), x.host ? h("span", { class: "pill host" }, x.host) : null, x.session_id ? h("span", { class: "pill", title: x.session_id }, `session ${x.session_id.slice(0, 8)}`) : null),
        h("div", { class: "sub" }, `${ago(x.ts)} · ${x.text ? `"${clip(x.text, 90)}"` : x.statement_id}`),
        x.src ? h("div", { class: "sub mono" }, srcLabel(x.src, store.homeDir)) : null)))
      : h("p", { class: "note" }, "No agent has looked anything up yet."));

  const hosts = Object.entries(index.byHost);
  const last = index.lastIndex;
  const idx = h("section", { class: "panel" },
    h("h2", null, "Index"),
    h("p", { class: "note" }, `${int(index.statements)} statements${hosts.length ? `: ${hosts.map(([k, v]) => `${k} ${int(v)}`).join(", ")}` : ""}.`),
    last ? h("p", { class: "note" }, `Last run ${ago(last.at)}${last.added === null ? "" : `, added ${int(last.added)}`}${last.homes ? `, ${last.homes} homes read` : ""}.`) : h("p", { class: "note" }, "No index run recorded."));

  replace(sideEl, today, chart, live, lookups, idx);
}
