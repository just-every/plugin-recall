// Recall Monitor: wire the parts together.
import { initDetail, renderDetail } from "./detail.js";
import { initFilters, renderFilters } from "./filters.js";
import { renderFeed, tickFeed } from "./feed.js";
import { connect, watchConnection } from "./live.js";
import { renderSide } from "./side.js";
import { notify, subscribe } from "./store.js";
import { renderTopbar, tickTopbar } from "./topbar.js";

subscribe(renderTopbar);
subscribe(renderFilters);
subscribe(renderFeed);
subscribe(renderSide);
subscribe(renderDetail);

initFilters();
initDetail();
connect();
watchConnection();

// Between data events the relative times and the 30-minute session window still move.
setInterval(() => { tickFeed(); tickTopbar(); }, 20_000);
setInterval(() => notify(), 60_000);
notify();
