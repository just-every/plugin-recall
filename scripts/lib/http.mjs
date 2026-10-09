// POST JSON with retry. Retries ONLY on 429, 5xx and network errors. A client-side timeout is NOT retried (the server may still
// have billed the request): it throws RecallTimeoutError. Every other status throws ApiError at once. Plus a hard `deadlineAt` so a hook never sleeps past its budget.

export class ApiError extends Error {
  constructor(url, status, body, headers) {
    super(`POST ${url} -> ${status}: ${String(body).slice(0, 1000)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.requestId = headers["x-request-id"] ?? null;
  }
}

export class RecallTimeoutError extends Error {
  constructor(url, timeoutMs, attempt) {
    super(`POST ${url}: no response within ${timeoutMs}ms (attempt ${attempt}); the server may still have processed and billed it. Not retried.`);
    this.name = "RecallTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function parseRetryAfterMs(headers, now = Date.now()) {
  const ms = headers["retry-after-ms"];
  if (ms !== undefined && ms.trim() !== "" && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headers["retry-after"];
  if (ra === undefined) return null;
  if (ra.trim() !== "" && Number.isFinite(Number(ra))) return Math.max(0, Number(ra) * 1000);
  const date = Date.parse(ra);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export const backoffMs = (attempt, base, max, random = Math.random()) => Math.round(Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + 0.5 * random));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {unknown} body
 * @param {{apiKey: string, timeoutMs?: number, deadlineAt?: number, maxRetries?: number, baseDelayMs?: number, maxDelayMs?: number,
 *          label?: string, fetchImpl?: typeof fetch, sleepImpl?: (ms:number)=>Promise<void>, onRetry?: (e:object)=>void}} opts
 */
export async function postJson(url, body, opts) {
  const { apiKey, label = url, fetchImpl = fetch, sleepImpl = sleep } = opts;
  const maxRetries = opts.maxRetries ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const payload = JSON.stringify(body);
  const started = performance.now();
  for (let attempt = 1; ; attempt++) {
    let timeoutMs = opts.timeoutMs ?? 180000;
    if (opts.deadlineAt !== undefined) {
      const left = opts.deadlineAt - Date.now();
      if (left <= 0) throw new RecallTimeoutError(url, 0, attempt);
      timeoutMs = Math.min(timeoutMs, left);
    }
    const t0 = performance.now();
    let res;
    let text = "";
    let networkReason = null;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      if (e?.name === "TimeoutError") throw new RecallTimeoutError(url, timeoutMs, attempt);
      const cause = e?.cause?.code ?? e?.cause?.message ?? "";
      networkReason = `network: ${e?.name ?? "Error"}: ${e?.message ?? e}${cause ? ` (${cause})` : ""}`;
    }
    const latencyMs = performance.now() - t0;
    let reason = null;
    const headers = {};
    if (res) res.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
    if (networkReason) reason = networkReason;
    else if (res.status === 429 || res.status >= 500) {
      reason = String(res.status);
      if (res.status === 429 && /"code"\s*:\s*"insufficient_quota"/.test(text)) throw new ApiError(url, res.status, text, headers);
    } else if (res.status < 200 || res.status >= 300) throw new ApiError(url, res.status, text, headers);

    if (reason === null) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`POST ${url} -> ${res.status}: response body is not JSON: ${text.slice(0, 300)}`);
      }
      return { status: res.status, headers, json, latencyMs, totalMs: performance.now() - started, attempts: attempt, requestId: headers["x-request-id"] ?? null };
    }
    if (attempt > maxRetries) {
      if (res) throw new ApiError(url, res.status, text, headers);
      throw new Error(`POST ${url}: ${reason} after ${attempt} attempts`);
    }
    const retryAfterMs = res ? parseRetryAfterMs(headers) : null;
    const waitMs = Math.max(backoffMs(attempt, baseDelayMs, maxDelayMs), retryAfterMs ?? 0);
    if (opts.deadlineAt !== undefined && Date.now() + waitMs >= opts.deadlineAt) {
      throw new Error(`POST ${url}: ${reason}; the retry wait of ${waitMs}ms would pass the deadline, giving up (attempt ${attempt})`);
    }
    opts.onRetry?.({ label, attempt, reason, waitMs });
    process.stderr.write(`[recall retry] ${label} attempt ${attempt}/${maxRetries + 1} failed (${reason}); waiting ${waitMs}ms\n`);
    await sleepImpl(waitMs);
  }
}
