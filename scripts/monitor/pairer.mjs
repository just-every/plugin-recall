// Pair hook lines into turns. A UserPromptSubmit line and the Stop line(s) of the same session and turn_key are one turn. A Stop with no
// turn_key, or whose turn_key matches no prompt (when the prompts have none either), pairs by session_id with the nearest preceding prompt
// that has no Stop yet. A Stop after Recall's own block (stop_hook_active) carries the same turn_key, so one turn can have several Stop
// lines. A Stop whose prompt line is not in the log (older than the window) is a turn of its own, and so is every line that is not a prompt
// or a stop (the background index's errors, a crash before the payload was read). Lines are fed in the order they were written.
export function createPairer() {
  const turns = new Map(); // id -> {id, prompt, stops}
  const byKey = new Map(); // `${session}|${turn_key}` -> turn
  const open = new Map(); // session -> turns with a prompt and no Stop yet, oldest first
  let seq = 0;

  const keyOf = (l) => (l.session_id && l.turn_key ? `${l.session_id}|${l.turn_key}` : null);
  const mint = (l, hint) => {
    let id = `${l.session_id ?? "-"}|${l.turn_key ?? l.ts}|${hint}`;
    if (turns.has(id)) id += `#${++seq}`;
    const turn = { id, prompt: null, stops: [] };
    turns.set(id, turn);
    return turn;
  };

  function unopen(session, turn) {
    const q = open.get(session);
    const i = q ? q.indexOf(turn) : -1;
    if (i >= 0) q.splice(i, 1);
    if (q && !q.length) open.delete(session);
  }

  /** The newest prompt of the session still waiting for a Stop (only one without a turn_key if the Stop has one); older waiting prompts were interrupted. */
  function takeOpen(session, keylessOnly) {
    const q = open.get(session);
    if (!q) return null;
    for (let i = q.length - 1; i >= 0; i--) {
      if (keylessOnly && q[i].prompt.turn_key) continue;
      const turn = q[i];
      q.splice(0, i + 1);
      if (!q.length) open.delete(session);
      return turn;
    }
    return null;
  }

  function add(l) {
    if (l.event === "prompt" && l.session_id) {
      const key = keyOf(l);
      const existing = key ? byKey.get(key) : null;
      const turn = existing && !existing.prompt ? existing : mint(l, "p");
      turn.prompt = l;
      if (key) byKey.set(key, turn);
      if (!open.has(l.session_id)) open.set(l.session_id, []);
      open.get(l.session_id).push(turn);
      return turn;
    }
    if (l.event === "stop" && l.session_id) {
      const key = keyOf(l);
      let turn = key ? byKey.get(key) : null;
      if (turn) unopen(l.session_id, turn);
      else turn = takeOpen(l.session_id, Boolean(key));
      if (!turn) {
        turn = mint(l, "s");
        if (key) byKey.set(key, turn);
      }
      turn.stops.push(l);
      return turn;
    }
    // housekeeping or crash lines: no session to pair with
    const turn = mint(l, l.event ?? "x");
    if (l.event === "stop") turn.stops.push(l);
    else turn.prompt = l;
    return turn;
  }

  function clear() {
    turns.clear();
    byKey.clear();
    open.clear();
  }

  /** Drop turns whose newest line is older than the cutoff (ISO string). */
  function prune(cutoffIso) {
    for (const [id, t] of turns) {
      const newest = [t.prompt, ...t.stops].filter(Boolean).reduce((m, l) => (l.ts > m ? l.ts : m), "");
      if (newest >= cutoffIso) continue;
      turns.delete(id);
      for (const [k, v] of byKey) if (v === t) byKey.delete(k);
      for (const [s, q] of open) {
        const i = q.indexOf(t);
        if (i >= 0) q.splice(i, 1);
        if (!q.length) open.delete(s);
      }
    }
  }

  return { add, clear, prune, turns: () => [...turns.values()], get: (id) => turns.get(id), get size() { return turns.size; } };
}
