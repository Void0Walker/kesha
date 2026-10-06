import { DatabaseSync } from "node:sqlite";

export interface CallLog {
  thread: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  // Exactly what was sent and received, already pseudonymized. Kept for reviewing leaks
  request: unknown;
  response: unknown;
}

/** SQLite on the data volume: cost log, per-thread history and placeholder mapping, small key/value state. */
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
    `);
  }

  today(now = new Date()): string {
    return now.toLocaleDateString("sv-SE", { timeZone: this.#timeZone });
  }

  logCall(c: CallLog, now = new Date()): void {
    this.db
      .prepare("INSERT INTO calls (ts, day, thread, model, prompt_tokens, completion_tokens, cost, request, response) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(now.toISOString(), this.today(now), c.thread, c.model, c.promptTokens, c.completionTokens, c.cost,
        JSON.stringify(c.request), JSON.stringify(c.response));
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
    const cutoff = now - maxIdleMs;
    const idle = this.db.prepare("SELECT thread FROM threads WHERE last_active < ?").all(cutoff) as { thread: string }[];
    for (const { thread } of idle) {
      this.db.prepare("DELETE FROM mappings WHERE thread = ?").run(thread);
      this.db.prepare("DELETE FROM threads WHERE thread = ?").run(thread);
    }
    return idle.length;
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
