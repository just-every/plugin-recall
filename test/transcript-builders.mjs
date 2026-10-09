// Transcripts for the v2 tests, built from the synthetic lines in fixtures/tail-lines.json and fixtures/claude-lines.json: only the message text and the
// timestamp of a real record are replaced, exactly as tail.test.mjs does, so every other field has the shape the hosts write.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { readFixture, tmpDir } from "./helpers.mjs";

const TAIL = JSON.parse(readFixture("tail-lines.json"));
const CLAUDE = JSON.parse(readFixture("claude-lines.json"));

export const claudeUser = (text, ts = "2026-09-01T10:00:00.000Z") => JSON.stringify({ ...JSON.parse(TAIL.user_typed), timestamp: ts, message: { role: "user", content: text } });
export const claudeQueued = (text, ts = "2026-09-01T10:00:00.000Z") => {
  const r = JSON.parse(CLAUDE.queued_human);
  r.timestamp = ts;
  r.attachment = { ...r.attachment, prompt: text, timestamp: ts };
  return JSON.stringify(r);
};
export const claudeAssistant = (text) => {
  const r = JSON.parse(TAIL.assistant_text);
  r.message.content = r.message.content.map((b) => (b.type === "text" ? { ...b, text } : b));
  return JSON.stringify(r);
};
export const claudeToolUse = () => TAIL.assistant_tool_use;
export const claudeToolResult = () => TAIL.tool_result;

const withItemText = (line, text, ts) => {
  const r = JSON.parse(line);
  r.timestamp = ts ?? r.timestamp;
  r.payload.item.content = r.payload.item.content.map((b) => ({ ...b, text }));
  return JSON.stringify(r);
};
export const codexUser = (text, ts = "2026-09-01T10:00:00.000Z") => withItemText(TAIL.codex_user, text, ts);
export const codexAgent = (text) => withItemText(TAIL.codex_agent, text);
export const codexCommand = () => TAIL.codex_command;

/** Write the lines to a transcript file (zstd-compressed when the name ends in .zst) and return its path. */
export function writeTranscript(name, lines, dir = tmpDir("recall-transcript")) {
  const file = path.join(dir, name);
  const text = `${lines.join("\n")}\n`;
  fs.writeFileSync(file, name.endsWith(".zst") ? zlib.zstdCompressSync(Buffer.from(text)) : text);
  return file;
}
