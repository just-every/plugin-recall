// The detail drawer for one turn: the full query and the situation sent to the judge, the candidates (kind, scope, gist) with the injection
// bar, the injected cards as rendered, the old Stop audit of earlier days with its block threshold, stats, settings with their sources, and
// the raw JSON lines.
import { h, replace } from "./dom.js";
import { bar as fmtBar, clock, dateOnly, dur, int, score, sourceName, srcLabel, usd } from "./format.js";
import { gateRows, gateSummary } from "./gate.js";
import { notify, select, store } from "./store.js";

const drawer = document.getElementById("drawer");
const statements = new Map(); // id -> row | null (not in the index)
const asked = new Set();
const rawOpen = new Set();
let shownId = null;
let opener = null;

function lookup(ids) {
  const need = ids.filter((id) => !statements.has(id) && !asked.has(id));
  if (!need.length) return;
  need.forEach((id) => asked.add(id));
  fetch(`/api/statements?ids=${encodeURIComponent(need.join(","))}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(({ statements: rows }) => { const found = new Map(rows.map((r) => [r.id, r])); need.forEach((id) => statements.set(id, found.get(id) ?? null)); notify(); })
    .catch(() => need.forEach((id) => asked.delete(id)));
}

const section = (title, note, ...body) => h("section", { class: "d-section" }, h("h3", null, title, note ? h("small", null, note) : null), ...body);
const kv = (rows) => h("dl", { class: "kv" }, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== "").flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
const chip = (half) => h("span", { class: `chip ${half.tone}`, "data-glyph": { injected: "◆", blocked: "▲", audited: "◇", error: "✕", capped: "!", empty: "○", skip: "–" }[half.kind] ?? "" }, half.label);

/** A score bar with a tick at the threshold. */
function scoreBar(value, mark, { wide = false, passClass = "pass" } = {}) {
  const passes = typeof value === "number" && value >= mark;
  return h("span", {
    class: `bar${wide ? " wide" : ""}${passes ? ` ${passClass}` : ""}`, role: "img",
    "aria-label": `${score(value)}, ${passes ? "at or above" : "below"} the bar ${fmtBar(mark)}`,
    vars: { "--v": Math.max(0, Math.min(1, value ?? 0)) * 100, "--m": mark * 100 },
  }, h("span", { class: "bar-fill" }), h("span", { class: "bar-mark" }));
}

const srcLine = (c) => (c.src ? h("span", { class: "why src-line mono", title: c.src }, `Source: ${srcLabel(c.src, store.homeDir)}`) : null);

/** The precision rules by the reason the turn log gives (cards/precision.mjs): what each keeps out before ranking. */
const EXCLUDED_WORDS = { "gist-placeholder": "Placeholder gist (a session-opening message)", "cites-location": "Cites a URL, a port or a file path", "cross-repo-long": "Long statement from another repo", "long-directive": "Long rule or preference" };

/** The statements the precision rules kept out of this turn's history, one row per rule: how many, and the newest ones the log names. */
function excludedRows(line) {
  return Object.entries(line.excluded ?? {}).map(([reason, e]) => [EXCLUDED_WORDS[reason] ?? reason, `${int(e.count)}${e.ids?.length ? ` (newest: ${e.ids.slice(-3).join(", ")})` : ""}`]);
}

const SCOPE_WORD = { global: "all projects", repo: "this repo", unclear: "unclear" };
const kindScope = (c) => (c.kind ? `${c.kind}${c.scope ? `, ${SCOPE_WORD[c.scope] ?? c.scope}` : ""}` : null);

function candidatesTable(line, bars) {
  const rows = line.candidates ?? [];
  if (!rows.length) return h("p", { class: "explain" }, "This line holds no candidates.");
  const injected = new Set(line.injected ?? []);
  const repeats = new Set(line.repeats ?? []);
  const gateById = new Map((line.applyGate?.rows ?? []).map((r) => [r.id, r]));
  const mark = bars.promptThreshold;
  const head = ["#", "Date", "Repo", "Kind", "Scope", "Text", mark === null ? "D" : `D (tick = ${fmtBar(mark)})`, "Emb rank", "BM25 rank", "Fused", "Shown?"];
  const numCols = new Set([6, 7, 8, 9]);
  return h("div", { class: "tablewrap" }, h("table", null,
    h("thead", null, h("tr", null, ...head.map((x, i) => h("th", { class: numCols.has(i) ? "num" : i === 10 ? "flag" : null }, x)))),
    h("tbody", null, ...rows.slice(0, 20).map((c, i) => {
      const d = c.parts?.d;
      const yes = injected.has(c.id);
      const passed = typeof d === "number" && mark !== null && d >= mark;
      const g = gateById.get(c.id);
      const why = !yes && repeats.has(c.id) ? "Passed the bar; injected earlier in this session."
        : !yes && g ? (g.p === null ? "Passed the bar; the apply gate got no answer for it." : g.pass ? "Passed the bar and the apply gate; cut by k." : `Passed the bar; the apply gate rated it ${score(g.p)}, below ${fmtBar(line.applyGate.threshold)}.`)
          : !yes && passed ? "Passed the bar; cut by k or as a repeat." : null;
      return h("tr", { class: yes ? "injected" : null },
        h("td", { class: "num" }, i + 1), h("td", { class: "num" }, dateOnly(c.ts)), h("td", null, c.repo ?? "–"),
        h("td", null, c.kind ?? "–"), h("td", null, c.scope ? (SCOPE_WORD[c.scope] ?? c.scope) : "–"),
        h("td", { class: "text" }, c.text, c.gist ? h("span", { class: "why" }, `Said while: ${c.gist}`) : null, srcLine(c), why ? h("span", { class: "why" }, why) : null),
        h("td", { class: "num" }, h("span", { class: "scorecell" }, mark === null || typeof d !== "number" ? null : scoreBar(d, mark), typeof d === "number" ? d.toFixed(2) : "–")),
        h("td", { class: "num" }, c.parts?.embRank ?? "–"), h("td", { class: "num" }, c.parts?.bm25Rank ?? "–"),
        h("td", { class: "num" }, typeof c.score === "number" ? c.score.toFixed(3) : "–"),
        h("td", { class: "flag" }, h("span", { class: `yesno ${yes ? "yes" : "no"}` }, yes ? "Yes" : "No")));
    }))));
}

/** The apply gate: every survivor with the probability of the question "does it apply to the task now", the bar, and the verdict. */
function gateSection(line) {
  const g = line.applyGate;
  const summary = gateSummary(line);
  if (!summary) return null;
  const byId = new Map((line.candidates ?? []).map((c) => [c.id, c]));
  const mark = g.threshold;
  const rows = gateRows(line, (id) => byId.get(id) ?? statements.get(id));
  lookup(rows.filter((r) => !r.row).map((r) => r.id));
  const table = h("div", { class: "tablewrap" }, h("table", null,
    h("thead", null, h("tr", null, ...["#", "Date", "Repo", "Text", `Apply probability (tick = ${fmtBar(mark)})`, "Verdict"].map((x, i) => h("th", { class: i === 4 ? "num" : i === 5 ? "flag" : null }, x)))),
    h("tbody", null, ...rows.map((r, i) => h("tr", { class: r.injected ? "injected" : null },
      h("td", { class: "num" }, i + 1), h("td", { class: "num" }, r.row?.ts ? dateOnly(r.row.ts) : "–"), h("td", null, r.row?.repo ?? "–"),
      h("td", { class: "text" }, r.row?.text ?? r.id, r.row?.gist ? h("span", { class: "why" }, `Said while: ${r.row.gist}`) : null),
      h("td", { class: "num" }, h("span", { class: "scorecell" }, typeof r.p === "number" ? scoreBar(r.p, mark) : null, typeof r.p === "number" ? r.p.toFixed(2) : "–")),
      h("td", { class: "flag" }, h("span", { class: `yesno ${r.injected ? "yes" : "no"}` }, r.verdict)))))));
  const facts = kv([["Survivors asked", int(g.survivors)], ["At the bar or more", int(g.passed ?? 0)], ["Injected", int(g.selected ?? 0)], ["No answer", g.refused ? int(g.refused) : null], ["Questions", int(g.questions ?? 0)], ["Cached requests", g.requests ? `${int(g.cachedRequests ?? 0)} of ${int(g.requests)}` : null], ["Cost", typeof g.costUsd === "number" ? usd(g.costUsd) : null], ["Time", typeof g.ms === "number" ? dur(g.ms) : null]]);
  return [h("h3", { class: "subhead-gap" }, "Apply gate"), h("p", { class: "legend" }, [h("span", { class: "tick" }), ` ${summary} The gate asks of each statement that passed the injection bar: does it apply to the task the assistant is doing now, not just the same topic? Survivors are reranked by that probability.`]), h("div", { class: "d-card" }, facts), table];
}

/** The injected statements as the cards the agent was shown, built from the candidates that were injected. */
function injectedCards(line) {
  const byId = new Map((line.candidates ?? []).map((c) => [c.id, c]));
  const cards = (line.injected ?? []).map((id) => byId.get(id)).filter(Boolean);
  if (!cards.length) return null;
  return h("div", { class: "cards" }, ...cards.map((c) => h("div", { class: "d-card" },
    h("div", null, h("span", { class: "pill" }, kindScope(c) ?? "statement"), c.repo ? h("span", { class: "pill" }, c.repo) : null, h("span", { class: "pill" }, dateOnly(c.ts))),
    c.gist ? h("p", { class: "explain" }, `Said while: ${c.gist}`) : null, h("p", null, c.text), c.src ? h("p", { class: "explain mono", title: c.src }, `Source: ${srcLabel(c.src, store.homeDir)}`) : null)));
}

function promptSection(half, bars) {
  const line = half.line;
  const body = [
    h("div", { class: "d-card" }, h("div", null, chip(half)), h("p", { class: "explain" }, half.detail), line.error ? h("p", { class: "explain" }, line.error) : null,
      kv([["Latency", dur(half.latencyMs)], ["Cost", half.costUsd === null ? null : usd(half.costUsd)], ["Eligible statements", line.eligible === undefined ? null : int(line.eligible)], ["Indexed statements", line.statements === undefined ? null : int(line.statements)], ["With a card", line.cards === undefined ? null : int(line.cards)], ["Repo", line.repo], ["Pipeline", line.pipeline], ...excludedRows(line).map(([k, v]) => [`Kept out before ranking: ${k}`, v])])),
  ];
  if (line.candidates?.length) {
    body.push(h("h3", { class: "subhead-gap" }, `Top ${Math.min(20, line.candidates.length)} candidates`),
      h("p", { class: "legend" }, bars.promptThreshold === null ? "Injection bar unknown (configuration unreadable)." : [h("span", { class: "tick" }), ` Injection bar: judge probability D at least ${fmtBar(bars.promptThreshold)}. Highlighted rows were injected.`]),
      candidatesTable(line, bars));
  }
  const gate = gateSection(line);
  if (gate) body.push(...gate);
  if (line.situation) body.push(h("h3", { class: "subhead-gap" }, "Situation sent to the judge"), h("pre", { class: "block" }, line.situation));
  const cards = injectedCards(line);
  if (cards) body.push(h("h3", { class: "subhead-gap" }, "Injected cards"), cards);
  if (line.context) body.push(h("h3", { class: "subhead-gap" }, "Injected block, exactly as the agent received it"), h("pre", { class: "block" }, line.context));
  return section("Prompt hook", `${clock(half.ts)}`, ...body);
}

function auditList(half, bars) {
  const line = half.line;
  const thr = bars.stopThreshold;
  const hits = new Map((line.hits ?? []).map((x) => [x.id, x]));
  const entries = (line.stats?.top?.length ? line.stats.top : (line.hits ?? [])).map((x) => ({ id: x.id, score: x.score }));
  if (!entries.length) return h("p", { class: "explain" }, line.audited ? `${line.audited} candidates were audited; the line does not record their scores.` : "No candidates were audited.");
  lookup(entries.filter((e) => !hits.has(e.id)).map((e) => e.id));
  return h("div", null,
    h("p", { class: "legend" }, thr === null ? "Block threshold unknown (configuration unreadable)." : [h("span", { class: "tick" }), ` Block threshold: violation score at least ${fmtBar(thr)}.`]),
    h("ul", { class: "audit-list" }, ...entries.map((e) => {
      const hit = hits.get(e.id);
      const row = statements.get(e.id);
      const text = hit?.text ?? row?.text ?? (statements.has(e.id) ? "This statement is not in the index (any more)." : "Loading the statement…");
      const over = thr !== null && e.score >= thr;
      return h("li", null,
        h("div", { class: "row1" }, thr === null ? null : scoreBar(e.score, thr, { wide: true, passClass: "stop-pass" }), h("span", { class: "score" }, score(e.score)),
          over ? h("span", { class: "chip bad", "data-glyph": "▲" }, "Reached the threshold") : null),
        h("p", null, text),
        h("div", { class: "src" }, [row?.repo ?? hit?.repo, row?.ts ? dateOnly(row.ts) : null, row?.host].filter(Boolean).join(" · ") || e.id),
        hit?.evidence ? h("p", { class: "explain" }, `Evidence: ${hit.evidence}`) : null);
    })));
}

function stopSection(half, bars, title) {
  const line = half.line;
  const body = [
    h("div", { class: "d-card" }, h("div", null, chip(half), line.pipeline ? h("span", { class: "pill" }, line.pipeline) : null), h("p", { class: "explain" }, half.detail), line.error ? h("p", { class: "explain" }, line.error) : null,
      kv([["Pipeline", line.pipeline], ["Candidates audited", line.audited ?? line.stats?.audited], ["Nominated", line.stats?.nominated], ["Refused by the judge", line.stats?.refused], ["Latency", dur(half.latencyMs)], ["Cost", half.costUsd === null ? null : usd(half.costUsd)]])),
  ];
  if (line.stats?.top?.length || line.hits?.length || line.audited) body.push(h("h3", { class: "subhead-gap" }, "Audited candidates"), auditList(half, bars));
  if (line.message) body.push(h("h3", { class: "subhead-gap" }, "The agent's final message (start)"), h("pre", { class: "block" }, line.message));
  if (half.feedback) body.push(h("h3", { class: "subhead-gap" }, "What the agent was told"), h("pre", { class: "block" }, half.feedback));
  return section(title, clock(half.ts), ...body);
}

const STAT_ROWS = [
  ["questions", "Questions", int], ["requests", "Requests", int], ["cachedRequests", "Cached requests", int], ["cacheHits", "Cache hits", int], ["costUsd", "Decisions cost", (v) => `$${v.toFixed(6)}`],
  ["embedCostUsd", "Embedding cost", (v) => `$${v.toFixed(7)}`], ["refused", "Refused", int], ["prefilterSize", "Prefilter size", int], ["embedMs", "Embedding", dur], ["prefilterMs", "Prefilter", dur],
  ["decisionsMs", "Decisions", dur], ["totalMs", "Retrieval total", dur], ["verifyMs", "Verification", dur], ["situationChars", "Situation (chars)", int],
];

function statsCard(title, half) {
  const stats = half.line.stats;
  const rows = [["Hook latency", half.latencyMs === null ? null : dur(half.latencyMs)]];
  for (const [key, label, fmt] of STAT_ROWS) if (typeof stats?.[key] === "number") rows.push([label, fmt(stats[key])]);
  return h("div", { class: "d-card" }, h("h3", null, title), rows.length > 1 || rows[0][1] ? kv(rows) : h("p", { class: "explain" }, "No stats on this line."));
}

const FLAG_LABELS = [["excludeKinds", "Kinds never injected"], ["scopeFilter", "Scope filter"], ["queryContext", "Conversation context"], ["itemGist", "Gist in the judge question"], ["noRepeat", "No repeats in a session"], ["hubMaxSessions", "Hub limit (other sessions)"]];

const APPLY_LABELS = [["applyGate", "Apply gate"], ["applyThreshold", "Apply gate bar (probability)"]];

const PRECISION_LABELS = [["excludeNewSessionGist", "Keep out placeholder gists"], ["excludeCitations", "Keep out cited URLs and paths"], ["crossRepoMaxChars", "Keep out cross-repo statements from (chars)"], ["ruleMaxChars", "Keep out rules and preferences from (chars)"]];

function settingsCard(halves, summary) {
  const rec = halves.map((x) => x.line.settings).find(Boolean);
  const recPrecision = halves.map((x) => x.line.precision).find(Boolean) ?? {};
  const recApply = halves.map((x) => x.line.apply).find(Boolean) ?? {};
  const src = (e) => (e ? h("span", null, e.value === null || (Array.isArray(e.value) && !e.value.length) ? "none" : String(e.value), h("span", { class: "src-tag" }, sourceName(e.source))) : null);
  const psrc = (e) => (e ? h("span", null, e.value === false || e.value === 0 ? "off" : e.value === true ? "on" : String(e.value), h("span", { class: "src-tag" }, sourceName(e.source))) : null);
  const now = summary?.settings;
  return h("div", { class: "two" },
    h("div", { class: "d-card" }, h("h3", null, "As the hook recorded them"), rec ? kv([["Daily cap", src(rec.dailyCapUsd)], ["Total cap", src(rec.totalCapUsd)], ["Statements injected (k)", src(rec.k)], ...FLAG_LABELS.map(([key, label]) => [label, src(rec[key])]), ...PRECISION_LABELS.map(([key, label]) => [label, psrc(recPrecision[key])]), ...APPLY_LABELS.map(([key, label]) => [label, psrc(recApply[key])]), ["Prompt pipeline", halves.find((x) => x.event === "prompt")?.line.pipeline], ["Data dir", halves[0].line.dataDir]]) : h("p", { class: "explain" }, "This line records no settings.")),
    h("div", { class: "d-card" }, h("h3", null, "In effect now"), now ? kv([["Injection bar", src(now.promptThreshold)], ["Statements injected (k)", src(now.k)], ["Prompt pipeline", src(now.pipeline)], ...FLAG_LABELS.map(([key, label]) => [label, src(now[key])]), ...PRECISION_LABELS.map(([key, label]) => [label, psrc(now[key])]), ...APPLY_LABELS.map(([key, label]) => [label, psrc(now[key])]), ["Daily cap", src(now.dailyCapUsd)], ["Total cap", src(now.totalCapUsd)]]) : h("p", { class: "explain" }, "The configuration could not be read.")));
}

function rawJson(label, half) {
  const key = `${half.event}|${half.ts}`;
  const d = h("details", { class: "raw", onToggle: (e) => { if (e.target.open) rawOpen.add(key); else rawOpen.delete(key); } },
    h("summary", null, `${label} line, raw JSON`), h("pre", null, JSON.stringify(half.line, null, 2)));
  if (rawOpen.has(key)) d.open = true;
  return d;
}

function build(t) {
  const bars = store.summary?.bars ?? { promptThreshold: null, stopThreshold: null };
  const stops = t.stops ?? (t.stop ? [t.stop] : []);
  const halves = [t.prompt, ...stops].filter(Boolean);
  const parts = [];
  parts.push(h("div", { class: "drawer-head" },
    h("div", { class: "who" }, h("h2", null, `${clock(t.ts)}${t.project ? ` · ${t.project}` : ""}`),
      h("div", { class: "meta" }, t.host ? h("span", { class: "pill host" }, t.host) : null, t.home ? h("span", { class: "pill" }, t.home) : null,
        t.session_id ? h("span", { class: "pill", title: t.session_id }, `session ${t.session_id.slice(0, 8)}`) : null, t.turn_key ? h("span", { class: "pill", title: t.turn_key }, `turn ${t.turn_key.slice(0, 8)}`) : null),
      t.cwd ? h("div", { class: "explain mono" }, t.cwd) : null),
    h("button", { class: "close", type: "button", "aria-label": "Close details", onclick: () => select(null) }, "×")));
  if (t.query) parts.push(section("Your query", t.query.length >= 400 ? "the log keeps the first 400 characters" : null, h("div", { class: "d-card" }, h("p", { class: "full-query" }, t.query))));
  if (t.prompt) parts.push(promptSection(t.prompt, bars));
  stops.forEach((x, i) => parts.push(stopSection(x, bars, stops.length > 1 ? `Stop hook of earlier days (${i + 1} of ${stops.length})` : "Stop hook of earlier days")));
  if (!t.prompt) parts.push(section("Prompt hook", null, h("p", { class: "explain" }, "The prompt line of this turn is older than the period shown.")));
  parts.push(section("Stats", null, h("div", { class: "two" }, ...[t.prompt && statsCard("Prompt hook", t.prompt), ...stops.map((x, i) => statsCard(stops.length > 1 ? `Stop hook ${i + 1}` : "Stop hook", x))].filter(Boolean))));
  parts.push(section("Settings", "and where each value came from", settingsCard(halves, store.summary)));
  parts.push(section("Raw log lines", null, ...halves.map((x, i) => rawJson(x.event === "prompt" ? "Prompt" : stops.length > 1 ? `Stop ${i}` : "Stop", x)),
    t.transcript ? h("p", { class: "explain mono" }, `transcript: ${t.transcript}`) : null));
  return parts;
}

export function renderDetail() {
  const t = store.selectedId ? store.turns.get(store.selectedId) : null;
  if (!t) {
    if (!drawer.hidden) {
      drawer.hidden = true;
      replace(drawer);
      const back = shownId && document.querySelector(`.card[data-id="${CSS.escape(shownId)}"]`);
      (back ?? opener)?.focus?.();
    }
    shownId = null;
    return;
  }
  const first = drawer.hidden || shownId !== t.id;
  const scroll = first ? 0 : drawer.scrollTop;
  if (drawer.hidden) opener = document.activeElement;
  replace(drawer, ...build(t));
  drawer.hidden = false;
  drawer.scrollTop = scroll;
  if (first) {
    drawer.classList.remove("opening");
    void drawer.offsetWidth;
    drawer.classList.add("opening");
    drawer.querySelector(".close")?.focus();
  }
  shownId = t.id;
}

export function initDetail() {
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) select(null); });
}
