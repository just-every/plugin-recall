// Spend by hour of the cap day (a UTC day), as a small SVG bar chart with the hours labelled in local time.
import { s } from "./dom.js";
import { localHour, usd } from "./format.js";

const W = 300;
const H = 104;
const TOP = 6;
const BASE = 84;

/** @param {number[]} byHour 24 values, UTC hour 0..23 of `day` @param {string} day YYYY-MM-DD (UTC) @param {number} nowMs */
export function spendChart(byHour, day, nowMs) {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const max = Math.max(...byHour, 0);
  const slot = W / 24;
  const nowHour = nowMs >= dayStart && nowMs < dayStart + 86_400_000 ? Math.floor((nowMs - dayStart) / 3_600_000) : -1;
  const peak = max > 0 ? byHour.indexOf(max) : -1;
  const svg = s("svg", {
    class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": max > 0 ? `Spend per hour today: ${usd(byHour.reduce((a, b) => a + b, 0))} in total, busiest hour ${localHour(dayStart + peak * 3_600_000)} with ${usd(max)}` : "No spend yet today",
  });
  svg.append(s("line", { x1: 0, x2: W, y1: BASE + 0.5, y2: BASE + 0.5 }));
  byHour.forEach((v, i) => {
    const hgt = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * (BASE - TOP)) : 0;
    const cls = v === 0 ? "cbar zero" : i === nowHour ? "cbar now" : "cbar";
    const rect = s("rect", { class: cls, x: i * slot + 1, width: slot - 2, y: v === 0 ? BASE - 1 : BASE - hgt, height: v === 0 ? 1 : hgt, rx: 1.5 },
      s("title", null, `${localHour(dayStart + i * 3_600_000)} local: ${usd(v)}`));
    svg.append(rect);
  });
  for (const i of [0, 6, 12, 18]) svg.append(s("text", { x: i * slot + 1, y: H - 8 }, localHour(dayStart + i * 3_600_000)));
  svg.append(s("text", { x: W, y: H - 8, "text-anchor": "end" }, localHour(dayStart + 86_400_000)));
  return svg;
}

export function peakText(byHour, day) {
  const max = Math.max(...byHour, 0);
  if (max === 0) return "No spend yet today.";
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const total = byHour.reduce((a, b) => a + b, 0);
  return `${usd(total)} so far today; busiest hour ${localHour(dayStart + byHour.indexOf(max) * 3_600_000)} (${usd(max)}).`;
}
