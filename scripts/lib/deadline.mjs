/** Race a promise against a hard deadline; the rejection is named RecallDeadline so the turn log says what happened. */
export function withDeadline(promise, ms, what) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${what} exceeded ${ms}ms`), { name: "RecallDeadline" })), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
