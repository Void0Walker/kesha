import { randomUUID } from "node:crypto";
import { Anonymizer, ProviderRedactionError, rejectProviderRedactions, UnknownPlaceholderError } from "./anonymizer.ts";
import type { ChatModel, Message, ReasoningEffort } from "./llm.ts";
import type { RoomProject } from "./commands.ts";
import type { Store } from "./store.ts";
import { dueOf, runTool, toolDefinitions, type Tool, type ToolContext } from "./tools.ts";
import { VikunjaAuthError, type Task } from "./vikunja.ts";

export interface Limits {
  maxSteps: number;
  maxTokens: number;
  maxCostPerRequest: number;
  alertCost: number;
  dailyCap: number;
  // Unset: the task model's default
  reasoning?: ReasoningEffort;
}

// Model and per-request caps for !research messages, which may search the web
export interface ResearchProfile {
  modelName: string;
  maxSteps: number;
  maxTokens: number;
  maxCostPerRequest: number;
  // Web searches per request, over all its model calls
  maxSearches: number;
  reasoning?: ReasoningEffort;
}

export type Mode = "task" | "research";

export interface AgentDeps {
  model: ChatModel;
  modelName: string;
  // Unset: research is off
  research?: ResearchProfile;
  tools: Tool[];
  // Open, non-private tasks of a project, for the room snapshot. Unset: no snapshot
  listOpenTasks?(projectId: number): Promise<Task[]>;
  anonymizer: Anonymizer;
  store: Store;
  limits: Limits;
  timeZone: string;
  now?: () => Date;
}

export interface TurnResult {
  reply: string;
  cost: number;
  searches: number;
  // Cost of this request and today's total, for the end of the reply. Unset when nothing was spent
  footer?: string;
  // Set when the request crossed the alert threshold
  alert?: string;
  // Vikunja rejected the token itself: tell the user loudly, stop using Vikunja
  tokenDead?: boolean;
}

// History over this size (JSON chars) is cut to HISTORY_TRIM_TO at a user message. The gap keeps the start of the
// history, and so the cached prompt prefix, unchanged for many turns instead of shifting every turn
const HISTORY_MAX_CHARS = 24_000;
const HISTORY_TRIM_TO = 12_000;
// Sources listed under a research reply
const MAX_SOURCES = 8;

const credits = (n: number) => `$${n.toFixed(4)}`;

export function costFooter(cost: number, searches: number, spentToday: number, dailyCap: number): string {
  const parts = [credits(cost)];
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
  parts.push(`today ${credits(spentToday)} of $${dailyCap.toFixed(2)}`);
  return `— ${parts.join(" · ")}`;
}

function sourceList(sources: Map<string, string | undefined>): string {
  const lines = [...sources].slice(0, MAX_SOURCES).map(([url, title], i) => `${i + 1}. ${title ? `${title} — ` : ""}${url}`);
  return lines.length ? `\n\nSources:\n${lines.join("\n")}` : "";
}

/** Local send time with weekday and UTC offset, e.g. "Sat 2026-10-11 14:22 +02:00". */
export function sentAt(now: Date, timeZone: string): string {
  const day = now.toLocaleDateString("en-US", { timeZone, weekday: "short" });
  const local = now.toLocaleString("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" });
  const offset = now.toLocaleString("en-US", { timeZone, timeZoneName: "longOffset" }).split("GMT")[1] || "+00:00";
  return `${day} ${local} ${offset}`;
}

// The prompt is the same for every call of a conversation, so providers can cache it: nothing time-dependent here,
// the send time is on each user message. Varying parts last. project: the room's default project, title pseudonymized
export function systemPrompt(mode: Mode, project?: RoomProject): string {
  return [
    "You are Kesha, a concise assistant that manages the user's tasks in Vikunja through the tools you have.",
    "Each user message starts with its local send time in brackets, like [Sat 2026-10-11 14:22 +02:00]. Resolve relative dates (\"tomorrow\", \"Friday\") against it, give due dates with that UTC offset, and don't repeat the bracket in replies.",
    "Names, places, emails and similar details are replaced by placeholders like <PERSON_1> or <EMAIL_2>. Treat each placeholder as the real value: use it as-is in tool arguments and replies, never invent new ones, never ask what it stands for.",
    "Square-bracket labels like [PERSON_NAME] or [ADDRESS] are different: that text was removed before you saw it and is lost. Never write them into tasks; tell the user which part you couldn't see.",
    "Some tasks are private. You can't see or change them; if a tool says a task is private, tell the user to handle it in Vikunja themselves.",
    "Only create or change tasks when the user asks you to. Talking about something is not a request to add a task.",
    "Before changing or creating tasks, look up ids with the tools instead of guessing. After a change, confirm briefly what was done.",
    "When you mention a task, add its id like (#41), so later messages can refer to it. Earlier tool results are not kept between messages.",
    "Task fields missing from tool results have their defaults: not done, priority 0, no due date, no labels.",
    "When the user asks you to note or record a decision, create one open task (not done): title \"Decision: \" and the decision in a few words; description with what was decided, the main reasons, the options ruled out, and today's date. Summarize, never copy the conversation into it. Only create a task as done when the user says it is already done.",
    "There is no delete tool. If the user wants a task deleted, mark it done or tell them to delete it in Vikunja.",
    "Chat commands start with \"!\" and are handled without you. If the user asks what commands exist or how to set something up, tell them to send !help.",
    "Reply in the user's language.",
    ...(mode === "research"
      ? [
          "You can search the web. Use it for anything current or factual you aren't sure about, and prefer primary sources.",
          "Placeholders mean nothing outside this chat: never put them in search queries. If a question depends on who a placeholder is, search for the general topic.",
          "Lead with the answer, then the key facts. Simple Markdown is fine (**bold**, lists); no tables or headings. Sources are listed under your reply automatically, don't list URLs yourself.",
        ]
      : ["Keep replies short. Simple Markdown is fine (**bold**, *italic*, lists, links); no tables or headings."]),
    ...(project
      ? [`This chat room belongs to the project "${project.title}" (id ${project.id}): new tasks go there unless the user names another project, and questions about tasks are about that project unless the user says otherwise.`]
      : []),
  ].join("\n");
}

/** At the end of a turn keep what was said: user messages and final replies. Tool calls, their results and reasoning
 * are dropped, they would be re-sent with every later call. Idempotent, also cleans histories from older versions. */
export function compactHistory(history: Message[]): Message[] {
  return history.flatMap((m): Message[] => {
    if (m.role === "tool" || (m.role === "assistant" && m.tool_calls?.length)) return [];
    if (m.role === "assistant" && "reasoning_details" in m) {
      const { reasoning_details: _, ...rest } = m as typeof m & { reasoning_details: unknown };
      return [rest];
    }
    return [m];
  });
}

/** Over HISTORY_MAX_CHARS, keep the newest ~HISTORY_TRIM_TO chars, starting at a user message. */
export function trimHistory(history: Message[]): Message[] {
  const size = (h: Message[]) => JSON.stringify(h).length;
  if (size(history) <= HISTORY_MAX_CHARS) return history;
  let start = 0;
  while (start < history.length - 1 && size(history.slice(start)) > HISTORY_TRIM_TO) start++;
  let first = history.findIndex((m, i) => i >= start && m.role === "user");
  if (first === -1) first = history.findLastIndex((m) => m.role === "user");
  return first === -1 ? [] : history.slice(first);
}

const NO_ANSWER = "I got no answer from the model. Please try again.";

// Room snapshot: the project's open tasks, given with the user message so most questions need no list_tasks call.
// Stored in history like the message itself (keeps the cached prefix stable), refreshed only when stale or changed
const SNAPSHOT_TASKS = 30;
const SNAPSHOT_TITLE = 60;
const SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

export function snapshotText(tasks: Task[], at: string, timeZone: string): string {
  const items = tasks.slice(0, SNAPSHOT_TASKS).map((t) => {
    const due = dueOf(t);
    const title = t.title.length > SNAPSHOT_TITLE ? `${t.title.slice(0, SNAPSHOT_TITLE - 1)}…` : t.title;
    return `#${t.id} ${title}${due ? ` · due ${new Date(due).toLocaleDateString("sv-SE", { timeZone })}` : ""}`;
  });
  const more = tasks.length > SNAPSHOT_TASKS ? `; and ${tasks.length - SNAPSHOT_TASKS} more` : "";
  return `(Context from Kesha, not from the user: open tasks of this room's project as of ${at}: ${items.length ? items.join("; ") : "none"}${more})`;
}

export class Agent {
  readonly #d: AgentDeps;
  readonly #toolDefs: ReturnType<typeof toolDefinitions>;

  constructor(deps: AgentDeps) {
    this.#d = deps;
    this.#toolDefs = toolDefinitions(deps.tools);
  }

  get dailyCap(): number {
    return this.#d.limits.dailyCap;
  }

  spentToday(): number {
    const { store } = this.#d;
    return store.spentOn(store.today(this.#now()));
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date();
  }

  async #snapshot(thread: string, project: RoomProject | undefined, now: Date, stamp: string): Promise<string | undefined> {
    const { store, listOpenTasks, timeZone } = this.#d;
    if (!project || !listOpenTasks) return undefined;
    const key = `snapshot:${thread}`;
    const prev = store.getState(key);
    const state = prev ? (JSON.parse(prev) as { at: number; stale?: boolean }) : undefined;
    if (state && !state.stale && now.getTime() - state.at < SNAPSHOT_MAX_AGE_MS) return undefined;
    try {
      const text = snapshotText(await listOpenTasks(project.id), stamp, timeZone);
      store.setState(key, JSON.stringify({ at: now.getTime() }));
      return text;
    } catch (e) {
      // Not fatal: a dead token shows up in the next tool call and is reported there
      console.warn("room snapshot skipped:", e);
      return undefined;
    }
  }

  #markSnapshotStale(thread: string): void {
    const key = `snapshot:${thread}`;
    const prev = this.#d.store.getState(key);
    if (prev) this.#d.store.setState(key, JSON.stringify({ ...JSON.parse(prev), stale: true }));
  }

  async turn(thread: string, room: string, userText: string, mode: Mode = "task", project?: RoomProject): Promise<TurnResult> {
    const { model, anonymizer, store, limits, tools, timeZone, research } = this.#d;
    if (mode === "research" && !research) {
      return { reply: "Research is not set up: KESHA_RESEARCH_MODEL is empty.", cost: 0, searches: 0 };
    }
    const run = mode === "research" && research
      ? research
      : {
          modelName: this.#d.modelName, maxSteps: limits.maxSteps, maxTokens: limits.maxTokens, maxCostPerRequest: limits.maxCostPerRequest,
          maxSearches: 0, ...(limits.reasoning ? { reasoning: limits.reasoning } : {}),
        };

    const spent = this.spentToday();
    if (spent >= limits.dailyCap) {
      return { reply: `Today's budget is used up (${credits(spent)} of ${credits(limits.dailyCap)}). I'm back tomorrow.`, cost: 0, searches: 0 };
    }

    const now = this.#now();
    const history = store.getHistory(thread) as Message[];
    // Record the thread before anything is pseudonymized, so the idle cleanup also finds its mappings
    store.saveHistory(thread, room, history, now.getTime());
    // The time goes on after pseudonymizing: it holds no PII, and the phone/card patterns must not see it
    const stamp = sentAt(now, timeZone);
    let content = `[${stamp}] ${anonymizer.anonymize(thread, userText).text}`;
    const snapshot = await this.#snapshot(thread, project, now, stamp);
    if (snapshot) content += `\n\n${anonymizer.anonymize(thread, snapshot).text}`;
    history.push({ role: "user", content });
    const promptProject = project && { id: project.id, title: anonymizer.anonymize(thread, project.title).text };
    // Built once per turn: identical bytes in every call keep the prompt cache warm
    const system: Message = { role: "system", content: systemPrompt(mode, promptProject) };
    const sessionId = store.sessionId(thread);
    // Everything this request changes is recorded under one id, so !undo reverts the request as a whole
    const turnId = randomUUID();
    let changed = false;
    const ctx: ToolContext = {
      recordChange: (c) => {
        changed = true;
        store.recordChange({ room, turnId, taskId: c.taskId, kind: c.kind, ...(c.before ? { before: c.before } : {}), after: c.after });
      },
    };

    let cost = 0;
    let searches = 0;
    const sources = new Map<string, string | undefined>();
    const finish = (reply: string, extra: Partial<TurnResult> = {}): TurnResult => ({
      reply, cost, searches, ...(cost > 0 ? { footer: costFooter(cost, searches, spent + cost, limits.dailyCap) } : {}), ...extra,
    });
    let reply: string | undefined;
    for (let step = 0; step < run.maxSteps; step++) {
      if (cost >= run.maxCostPerRequest) {
        reply = `I stopped: this request reached the cost limit of ${credits(run.maxCostPerRequest)} before I was done.`;
        break;
      }
      if (spent + cost >= limits.dailyCap) {
        reply = `I stopped: today's budget of ${credits(limits.dailyCap)} is used up.`;
        break;
      }

      const messages: Message[] = [system, ...history];
      const searchesLeft = run.maxSearches - searches;
      const res = await model.complete({
        model: run.modelName, messages, tools: this.#toolDefs, maxTokens: run.maxTokens, sessionId,
        ...(searchesLeft > 0 ? { webSearch: { maxSearches: searchesLeft } } : {}),
        ...(run.reasoning ? { reasoning: run.reasoning } : {}),
      });
      cost += res.cost;
      searches += res.searches;
      for (const c of res.citations) if (!sources.has(c.url)) sources.set(c.url, c.title);
      store.logCall({
        thread, room, model: res.model, promptTokens: res.promptTokens, completionTokens: res.completionTokens, cost: res.cost,
        searches: res.searches, cachedTokens: res.cachedTokens, reasoningTokens: res.reasoningTokens,
        request: { model: run.modelName, messages }, response: res.message,
      }, this.#now());
      history.push(res.message);

      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        const text = typeof res.message.content === "string" ? res.message.content.trim() : "";
        // An empty reply would be stored as an empty assistant message, which providers reject on the next call
        if (!text) history.pop();
        reply = text ? anonymizer.deanonymize(thread, text) : NO_ANSWER;
        break;
      }

      for (const call of calls) {
        if (call.type !== "function") continue;
        let result: unknown;
        try {
          const args = anonymizer.deanonymizeValueStrict(thread, JSON.parse(call.function.arguments || "{}"));
          rejectProviderRedactions(args);
          // In a room with a default project, new tasks go there unless the model named one
          if (project && call.function.name === "create_task" && args && typeof args === "object" && !("project_id" in args)) {
            (args as Record<string, unknown>).project_id = project.id;
          }
          result = (await runTool(tools, call.function.name, args, ctx)).result;
        } catch (e) {
          if (e instanceof VikunjaAuthError) {
            return finish("Vikunja rejected my token: it expired or was revoked. Rotate it (README, \"Rotating the Kesha Vikunja token\"). Nothing was changed.", { tokenDead: true });
          }
          if (e instanceof SyntaxError) result = { error: "arguments are not valid JSON" };
          else if (e instanceof UnknownPlaceholderError || e instanceof ProviderRedactionError) result = { error: e.message };
          else throw e;
        }
        history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(anonymizer.anonymizeValue(thread, result)) });
      }
    }

    if (reply === undefined) reply = `I stopped after ${run.maxSteps} steps without finishing. Try a narrower request.`;
    if (history.at(-1)?.role !== "assistant") history.push({ role: "assistant", content: anonymizer.anonymize(thread, reply).text });
    store.saveHistory(thread, room, trimHistory(compactHistory(history)), this.#now().getTime());
    if (changed) this.#markSnapshotStale(thread);

    const alert = cost >= limits.alertCost
      ? `This request cost ${credits(cost)}, above the alert threshold of ${credits(limits.alertCost)}.`
      : undefined;
    return finish(reply + sourceList(sources), alert ? { alert } : {});
  }
}
