// `recall monitor [--port 4777] [--host 127.0.0.1]`: start the monitor and keep running until Ctrl-C. It prints the address and does NOT
// open a browser or take focus; you open the page when you want it.
import { loadConfig } from "../lib/config.mjs";
import { createMonitorServer, isLoopback } from "./server.mjs";

export async function runMonitor(flags) {
  const config = loadConfig();
  const host = flags.get("host") ?? "127.0.0.1";
  const port = flags.has("port") ? Number(flags.get("port")) : 4777;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be an integer from 0 to 65535, got ${JSON.stringify(flags.get("port"))}`);
  if (!isLoopback(host)) throw new Error(`the monitor serves prompts and answers, so it binds to loopback only; --host must be 127.0.0.1, ::1 or localhost (got ${host})`);
  const monitor = createMonitorServer({ dataDir: config.dataDir, host, port, log: (s) => process.stderr.write(s) });
  let address;
  try { address = await monitor.listen(); } catch (e) {
    if (e.code === "EADDRINUSE") throw new Error(`port ${port} is already in use (is another recall monitor running? try --port)`);
    throw e;
  }
  process.stdout.write(`Recall Monitor: ${address.url}\nreading ${config.dataDir} (read-only); Ctrl-C to stop\n`);
  await new Promise((resolve) => {
    const stop = () => { monitor.close().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
