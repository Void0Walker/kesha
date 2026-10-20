// Voice messages: the audio goes to a Whistle transcription service (see the tools repo, stacks/whistle), and the
// text is handled like a typed message. "command <name> ..." in the transcript is the typed "!<name> ...".

export interface Transcript {
  text: string;
  // Length of the audio
  seconds: number;
}

export interface Transcriber {
  transcribe(audio: Buffer): Promise<Transcript>;
}

export class TranscribeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscribeError";
  }
}

const TIMEOUT_MS = 120_000;

/** The HTTP service in stacks/whistle: POST /transcribe with the audio as the body. */
export class WhistleClient implements Transcriber {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.#url = url.replace(/\/+$/, "");
    this.#fetch = fetchImpl;
  }

  async transcribe(audio: Buffer): Promise<Transcript> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#url}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(audio),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new TranscribeError(timedOut ? `transcription did not finish within ${TIMEOUT_MS / 1000} s` : "transcription service unreachable", { cause: e });
    }
    const body = (await res.json().catch(() => ({}))) as { text?: unknown; seconds?: unknown; error?: unknown };
    if (!res.ok) throw new TranscribeError(`transcription failed (HTTP ${res.status}): ${typeof body.error === "string" ? body.error : "no details"}`);
    if (typeof body.text !== "string") throw new TranscribeError("transcription service answered without text");
    return { text: body.text.trim(), seconds: typeof body.seconds === "number" ? body.seconds : 0 };
  }
}

// What the words after "command" mean. Two-word forms first: the transcript says "notify here", not "notify-here"
const COMMANDS: [RegExp, string][] = [
  [/^notify[- ]here\b/i, "notify-here"],
  [/^releases?[- ]here\b/i, "releases-here"],
  [/^errors?[- ]here\b/i, "errors-here"],
  [/^(?:research|r)\b/i, "research"],
  [/^costs?\b/i, "cost"],
  [/^today\b/i, "today"],
  [/^week\b/i, "week"],
  [/^open\b/i, "open"],
  [/^undo\b/i, "undo"],
  [/^new\b/i, "new"],
  [/^help\b/i, "help"],
  [/^project\b/i, "project"],
  [/^mode\b/i, "mode"],
];

/** A transcript that starts with "command <name>" becomes the typed "!<name> <rest>"; anything else is returned as it
 * is. Spoken punctuation ("Command today.", "Command research, what is...") is dropped where it would break the
 * command; a research question keeps its own. An unknown name still becomes "!<name>", so the user hears that it
 * doesn't exist instead of the model guessing. */
export function spokenCommand(transcript: string): string {
  const m = /^\W*command\b[\s,:.-]*([\s\S]*)$/i.exec(transcript.trim());
  if (!m || !m[1]!.trim()) return transcript;
  const rest = m[1]!.trim();
  for (const [re, name] of COMMANDS) {
    const hit = re.exec(rest);
    if (!hit) continue;
    let arg = rest.slice(hit[0].length).replace(/^[\s,:.-]+/, "").trim();
    if (name !== "research") arg = arg.replace(/[\s.,!?]+$/, "").toLowerCase();
    return arg ? `!${name} ${arg}` : `!${name}`;
  }
  const word = /^[\p{L}-]+/u.exec(rest)?.[0] ?? rest;
  return `!${word.toLowerCase()}`;
}
