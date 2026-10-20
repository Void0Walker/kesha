import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** "2026-10-25" plus n calendar days. Date strings, not 24-hour steps: those skip or repeat a day around DST changes. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface ChangeRow {
  room: string;
  turnId: string;
  taskId: number;
  kind: "create" | "update";
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface CallLog {
  thread: string;
  room?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  searches?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  // Exactly what was sent and received, already pseudonymized. Kept for reviewing leaks
  request: unknown;
  response: unknown;
}

/** SQLite on the data volume: cost log, per-conversation history and placeholder mapping, small key/value state.
 * Columns named "thread" hold conversation keys: Matrix threads until 0.6, room conversations since 0.7. */
export class Store {
  readonly db: DatabaseSync;
  readonly #timeZone: string;

  constructor(path: string, timeZone: string) {
    this.db = new DatabaseSync(path);
    this.#timeZone = timeZone;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY, ts TEXT NOT NULL, day TEXT NOT NULL, thread TEXT NOT NULL, model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, cost REAL NOT NULL,
        request TEXT NOT NULL, response TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_day ON calls(day);
      CREATE TABLE IF NOT EXISTS threads (
        thread TEXT PRIMARY KEY, room TEXT NOT NULL, last_active INTEGER NOT NULL, history TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mappings (
        thread TEXT NOT NULL, placeholder TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (thread, placeholder));
      CREATE INDEX IF NOT EXISTS mappings_value ON mappings(thread, value);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Research threads until 0.6; research is per message since 0.7
      DROP TABLE IF EXISTS thread_modes;
      -- Kesha's task changes, for !undo. Real task text: pruned after a few days
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY, room TEXT NOT NULL, turn_id TEXT NOT NULL, ts INTEGER NOT NULL, task_id INTEGER NOT NULL,
        kind TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL, undone_at INTEGER);
      CREATE INDEX IF NOT EXISTS changes_room ON changes(room, id);
    `);
    // Added in 0.6.0. Nullable, so an older image can still insert rows after a rollback
    const columns = new Set((this.db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [["room", "TEXT"], ["searches", "INTEGER"], ["cached_tokens", "INTEGER"], ["reasoning_tokens", "INTEGER"]]) {
      if (!columns.has(name!)) this.db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`);
    }
  }

  today(now = new Date()): string {
    return now.toLocaleDateString("sv-SE", { timeZone: this.#timeZone });
  }

  logCall(c: CallLog, now = new Date()): void {
    this.db
      .prepare("INSERT INTO calls (ts, day, thread, room, model, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, searches, cost, request, response) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(now.toISOString(), this.today(now), c.thread, c.room ?? null, c.model, c.promptTokens, c.completionTokens,
        c.cachedTokens ?? null, c.reasoningTokens ?? null, c.searches ?? null, c.cost, JSON.stringify(c.request), JSON.stringify(c.response));
  }

  /** The request/response bodies are for reviewing leaks and grow fast: blank them after maxAgeMs, keep the costs.
   * Once a month the file is compacted. Returns the number of blanked rows. */
  pruneCallBodies(maxAgeMs: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    const r = this.db.prepare("UPDATE calls SET request = '', response = '' WHERE ts < ? AND request != ''").run(cutoff);
    const month = now.toISOString().slice(0, 7);
    if (this.getState("last-vacuum") !== month) {
      this.db.exec("VACUUM");
      this.setState("last-vacuum", month);
    }
    return Number(r.changes);
  }

  /** Session id for OpenRouter's sticky routing: stable per conversation, but not a Matrix id and not linkable to one. */
  sessionId(thread: string): string {
    let secret = this.getState("session-secret");
    if (!secret) {
      secret = randomUUID();
      this.setState("session-secret", secret);
    }
    return createHash("sha256").update(`${secret}:${thread}`).digest("hex").slice(0, 32);
  }

  spentOn(day: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS total FROM calls WHERE day = ?").get(day) as { total: number };
    return row.total;
  }

  getHistory(thread: string): unknown[] {
    const row = this.db.prepare("SELECT history FROM threads WHERE thread = ?").get(thread) as { history: string } | undefined;
    return row ? (JSON.parse(row.history) as unknown[]) : [];
  }

  saveHistory(thread: string, room: string, history: unknown[], now = Date.now()): void {
    this.db
      .prepare("INSERT INTO threads (thread, room, last_active, history) VALUES (?,?,?,?) ON CONFLICT(thread) DO UPDATE SET room = excluded.room, last_active = excluded.last_active, history = excluded.history")
      .run(thread, room, now, JSON.stringify(history));
  }

  findPlaceholder(thread: string, value: string): string | undefined {
    const row = this.db.prepare("SELECT placeholder FROM mappings WHERE thread = ? AND value = ?").get(thread, value) as { placeholder: string } | undefined;
    return row?.placeholder;
  }

  lookupPlaceholder(thread: string, placeholder: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM mappings WHERE thread = ? AND placeholder = ?").get(thread, placeholder) as { value: string } | undefined;
    return row?.value;
  }

  countKind(thread: string, kind: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM mappings WHERE thread = ? AND kind = ?").get(thread, kind) as { n: number };
    return row.n;
  }

  addMapping(thread: string, placeholder: string, kind: string, value: string): void {
    this.db.prepare("INSERT INTO mappings (thread, placeholder, kind, value) VALUES (?,?,?,?)").run(thread, placeholder, kind, value);
  }

  /** Mappings are PII themselves: drop them, with the history, once a thread has been idle long enough. */
  forgetIdleThreads(maxIdleMs: number, now = Date.now()): number {
    const idle = this.db.prepare("SELECT thread FROM threads WHERE last_active < ?").all(now - maxIdleMs) as { thread: string }[];
    for (const { thread } of idle) this.#forget(thread);
    return idle.length;
  }

  /** Conversations that are no longer the current one of their room are never read again: forget them soon instead
   * of after the 30-day idle time. */
  forgetEndedConversations(active: Set<string>, maxIdleMs: number, now = Date.now()): number {
    const idle = this.db.prepare("SELECT thread FROM threads WHERE last_active < ?").all(now - maxIdleMs) as { thread: string }[];
    const ended = idle.filter(({ thread }) => !active.has(thread));
    for (const { thread } of ended) this.#forget(thread);
    return ended.length;
  }

  // Everything about one conversation goes at once, including every "<something>:<conversation>" state key (snapshot,
  // note, research, language, and whatever a later version adds): a key not on a hand-kept list can't survive the forget
  #forget(thread: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM mappings WHERE thread = ?").run(thread);
      this.db.prepare("DELETE FROM threads WHERE thread = ?").run(thread);
      this.db.prepare("DELETE FROM state WHERE key LIKE '%:' || ? ESCAPE '\\'").run(thread.replace(/[\\%_]/g, "\\$&"));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  recordChange(c: ChangeRow, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO changes (room, turn_id, ts, task_id, kind, before_json, after_json) VALUES (?,?,?,?,?,?,?)")
      .run(c.room, c.turnId, now, c.taskId, c.kind, c.before ? JSON.stringify(c.before) : null, JSON.stringify(c.after));
  }

  /** The changes of the room's latest request that hasn't been undone, newest first. */
  lastChanges(room: string): (ChangeRow & { id: number })[] {
    const last = this.db.prepare("SELECT turn_id FROM changes WHERE room = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1").get(room) as { turn_id: string } | undefined;
    if (!last) return [];
    const rows = this.db.prepare("SELECT * FROM changes WHERE room = ? AND turn_id = ? AND undone_at IS NULL ORDER BY id DESC").all(room, last.turn_id) as {
      id: number; room: string; turn_id: string; task_id: number; kind: "create" | "update"; before_json: string | null; after_json: string;
    }[];
    return rows.map((r) => ({
      id: r.id, room: r.room, turnId: r.turn_id, taskId: r.task_id, kind: r.kind,
      ...(r.before_json ? { before: JSON.parse(r.before_json) } : {}), after: JSON.parse(r.after_json),
    }));
  }

  markUndone(ids: number[], now = Date.now()): void {
    for (const id of ids) this.db.prepare("UPDATE changes SET undone_at = ? WHERE id = ?").run(now, id);
  }

  pruneChanges(maxAgeMs: number, now = Date.now()): number {
    return Number(this.db.prepare("DELETE FROM changes WHERE ts < ?").run(now - maxAgeMs).changes);
  }

  /** Spend per local day over the last `days` days, for one room and in total, plus the share of cached prompt tokens. */
  costReport(room: string, days: number, now = new Date()): { days: { day: string; total: number; room: number }[]; cachedShare: number } {
    const today = this.today(now);
    const list = Array.from({ length: days }, (_, i) => addDays(today, -i));
    const rows = this.db.prepare(
      `SELECT day, SUM(cost) AS total, SUM(CASE WHEN room = ? THEN cost ELSE 0 END) AS room,
              SUM(prompt_tokens) AS prompt, SUM(COALESCE(cached_tokens, 0)) AS cached
       FROM calls WHERE day >= ? GROUP BY day`,
    ).all(room, list.at(-1)!) as { day: string; total: number; room: number; prompt: number; cached: number }[];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const prompt = rows.reduce((n, r) => n + r.prompt, 0);
    return {
      days: list.map((day) => ({ day, total: byDay.get(day)?.total ?? 0, room: byDay.get(day)?.room ?? 0 })),
      cachedShare: prompt ? rows.reduce((n, r) => n + r.cached, 0) / prompt : 0,
    };
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  deleteState(key: string): void {
    this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
  }

  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
