import { escapeHtml, type MatrixText } from "./format.ts";

// Error reports to the room set with !errors-here: what failed, the error and where in the code, so a failure can be
// looked at without the server logs. Opt-in: without that room errors only go to the logs.

// The same failure again within this time is counted, not sent
const REPEAT_MS = 15 * 60_000;
const MAX_FRAMES = 6;
const MAX_DETAILS = 2000;

/** An error from an earlier run (a crash), already described when it happened. */
export class PastError extends Error {
  readonly details: string;
  constructor(details: string) {
    super(details.split("\n")[0]);
    this.name = "PastError";
    this.details = details;
  }
}

/** Name, message, HTTP status and the first stack frames of an error and its causes, paths shortened. */
export function describeError(e: unknown): string {
  if (e instanceof PastError) return e.details;
  const lines: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 3; depth++) {
    if (depth) lines.push("Caused by:");
    if (!(cur instanceof Error)) {
      lines.push(String(cur));
      break;
    }
    const status = (cur as { status?: unknown }).status;
    lines.push(`${cur.name}: ${cur.message}${typeof status === "number" ? ` (HTTP ${status})` : ""}`);
    const frames = (cur.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).slice(0, MAX_FRAMES);
    lines.push(...frames.map((l) => `  ${l.trim().replace(/file:\/\/\/app\//g, "")}`));
    cur = cur.cause;
  }
  const text = lines.join("\n");
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS)}…` : text;
}

/** The notice for one failure. room: where it happened, shown as a link Element turns into the room's name. */
export function errorContent(what: string, e: unknown, room?: string, repeats = 0): MatrixText {
  const first = e instanceof PastError ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const again = repeats ? ` (${repeats} more like this since the last report)` : "";
  const roomLink = room && `https://matrix.to/#/${encodeURIComponent(room)}`;
  const details = describeError(e);
  return {
    msgtype: "m.notice",
    body: `⚠️ ${what}${roomLink ? ` in ${roomLink}` : ""}${again}\n\n${details}`,
    format: "org.matrix.custom.html",
    formatted_body:
      `<p>⚠️ <strong>${escapeHtml(what)}</strong>${roomLink ? ` in <a href="${escapeHtml(roomLink)}">${escapeHtml(room!)}</a>` : ""}${escapeHtml(again)}<br>` +
      `<code>${escapeHtml(first.split("\n")[0]!)}</code></p><pre><code>${escapeHtml(details)}</code></pre>`,
  };
}

/** Sends error notices, at most one per kind of failure per 15 minutes. Never throws: reporting must not add a failure. */
export class ErrorReporter {
  readonly #send: (content: MatrixText) => Promise<boolean>;
  readonly #now: () => number;
  readonly #recent = new Map<string, { at: number; held: number }>();

  constructor(send: (content: MatrixText) => Promise<boolean>, now: () => number = Date.now) {
    this.#send = send;
    this.#now = now;
  }

  async report(what: string, e: unknown, room?: string): Promise<void> {
    const key = `${what}\n${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    const now = this.#now();
    const seen = this.#recent.get(key);
    if (seen && now - seen.at < REPEAT_MS) {
      seen.held++;
      return;
    }
    this.#recent.set(key, { at: now, held: 0 });
    for (const [k, v] of this.#recent) if (now - v.at >= REPEAT_MS && k !== key) this.#recent.delete(k);
    try {
      await this.#send(errorContent(what, e, room, seen?.held ?? 0));
    } catch (err) {
      console.error("error report failed:", err);
    }
  }
}
