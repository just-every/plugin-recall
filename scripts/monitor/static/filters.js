// The filter row above the feed: host, home, period, show skips, text search.
import { h, replace } from "./dom.js";
import { filterOptions, windowTurns } from "./selectors.js";
import { setFilters, store } from "./store.js";
import { loadSnapshot } from "./live.js";

const els = {
  form: document.getElementById("filters"),
  host: document.getElementById("f-host"),
  home: document.getElementById("f-home"),
  hours: document.getElementById("f-hours"),
  skips: document.getElementById("f-skips"),
  q: document.getElementById("f-q"),
};
const PERIODS = [[1, "Last hour"], [6, "Last 6 hours"], [24, "Last 24 hours"], [72, "Last 3 days"], [168, "Last 7 days"]];

const signatures = new Map();
function fillSelect(select, allLabel, values, current) {
  const sig = JSON.stringify([values, current]);
  if (signatures.get(select) === sig) return; // rebuilding the options would close a dropdown the user has open
  signatures.set(select, sig);
  const options = [h("option", { value: "" }, allLabel), ...values.map((v) => h("option", { value: v }, v))];
  if (current && !values.includes(current)) options.push(h("option", { value: current }, current));
  replace(select, ...options);
  select.value = current;
}

export function initFilters() {
  replace(els.hours, ...PERIODS.map(([v, label]) => h("option", { value: v }, label)));
  els.form.addEventListener("submit", (e) => e.preventDefault());
  els.host.addEventListener("change", () => setFilters({ host: els.host.value }));
  els.home.addEventListener("change", () => setFilters({ home: els.home.value }));
  els.hours.addEventListener("change", () => { setFilters({ hours: Number(els.hours.value) }); loadSnapshot(); });
  els.skips.addEventListener("change", () => setFilters({ showSkips: els.skips.checked }));
  let timer;
  els.q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => setFilters({ q: els.q.value }), 150); });
  els.q.value = store.filters.q;
}

export function renderFilters() {
  const { hosts, homes } = filterOptions(windowTurns());
  const f = store.filters;
  fillSelect(els.host, "All hosts", hosts, f.host);
  fillSelect(els.home, "All homes", homes, f.home);
  els.hours.value = String(f.hours);
  els.skips.checked = f.showSkips;
}
