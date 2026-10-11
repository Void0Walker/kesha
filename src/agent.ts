import { Anonymizer, ProviderRedactionError, rejectProviderRedactions, UnknownPlaceholderError } from "./anonymizer.ts";
import type { ChatModel, Message } from "./llm.ts";
import type { RoomProject } from "./commands.ts";
import type { Store } from "./store.ts";
import { runTool, toolDefinitions, type Tool } from "./tools.ts";
import { VikunjaAuthError } from "./vikunja.ts";

export interface Limits {
  maxSteps: number;
  maxTokens: number;
  maxCostPerRequest: number;
  alertCost: number;
  dailyCap: number;
}

// Model and per-request caps for !research threads, which may search the web
export interface ResearchProfile {
  modelName: string;
  maxSteps: number;
  maxTokens: number;
  maxCostPerRequest: number;
  // Web searches per request, over all its model calls
  maxSearches: number;
}

export type Mode = "task" | "research";

export interface AgentDeps {
  model: ChatModel;
  modelName: string;
  // Unset: research is off
  research?: ResearchProfile;
  tools: Tool[];
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

// Older messages are dropped from the thread history beyond this, cut at a user message
const MAX_HISTORY = 40;
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

// project: the room's default project, its title already pseudonymized
function systemPrompt(now: Date, timeZone: string, mode: Mode, project?: RoomProject): string {
  const local = now.toLocaleString("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" });
  return [
    "You are Kesha, a concise assistant that manages the user's tasks in Vikunja through the tools you have.",
    `Now: ${local} (${timeZone}). Resolve relative dates ("tomorrow", "Friday") against this, and give due dates with the UTC offset of ${timeZone}.`,
    "Names, places, emails and similar details are replaced by placeholders like <PERSON_1> or <EMAIL_2>. Treat each placeholder as the real value: use it as-is in tool arguments and replies, never invent new ones, never ask what it stands for.",
    "Square-bracket labels like [PERSON_NAME] or [ADDRESS] are different: that text was removed before you saw it and is lost. Never write them into tasks; tell the user which part you couldn't see.",
    "Some tasks are private. You can't see or change them; if a tool says a task is private, tell the user to handle it in Vikunja themselves.",
    "Before changing or creating tasks, look up ids with the tools instead of guessing. After a change, confirm briefly what was done.",
    ...(project
      ? [`This chat room belongs to the project "${project.title}" (id ${project.id}): new tasks go there unless the user names another project, and questions about tasks are about that project unless the user says otherwise.`]
      : []),
    "There is no delete tool. If the user wants a task deleted, mark it done or tell them to delete it in Vikunja.",
    "Chat commands start with \"!\" and are handled without you. If the user asks what commands exist or how to set something up, tell them to send !help.",
    "Reply in the user's language.",
    ...(mode === "research"
      ? [
          "You can search the web. Use it for anything current or factual you aren't sure about, and prefer primary sources.",
          "Placeholders mean nothing outside this chat: never put them in search queries. If a question depends on who a placeholder is, search for the general topic.",
          "Lead with the answer, then the key facts. Plain text, short lists are fine, no Markdown tables or headings. Sources are listed under your reply automatically, don't list URLs yourself.",
        ]
      : ["Keep replies short, plain text, no Markdown tables."]),
  ].join("\n");
}

/** Keep the tail of the history, starting at a user message so tool calls and their results stay together. */
function trimHistory(history: Message[]): Message[] {
  if (history.length <= MAX_HISTORY) return history;
  const tail = history.slice(-MAX_HISTORY);
  const start = tail.findIndex((m) => m.role === "user");
  return start === -1 ? [] : tail.slice(start);
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

  async turn(thread: string, room: string, userText: string, mode: Mode = "task", project?: RoomProject): Promise<TurnResult> {
    const { model, anonymizer, store, limits, tools, timeZone, research } = this.#d;
    if (mode === "research" && !research) {
      return { reply: "Research is not set up: KESHA_RESEARCH_MODEL is empty.", cost: 0, searches: 0 };
    }
    const run = mode === "research" && research
      ? research
      : { modelName: this.#d.modelName, maxSteps: limits.maxSteps, maxTokens: limits.maxTokens, maxCostPerRequest: limits.maxCostPerRequest, maxSearches: 0 };

    const spent = this.spentToday();
    if (spent >= limits.dailyCap) {
      return { reply: `Today's budget is used up (${credits(spent)} of ${credits(limits.dailyCap)}). I'm back tomorrow.`, cost: 0, searches: 0 };
    }

    const history = store.getHistory(thread) as Message[];
    // Record the thread before anything is pseudonymized, so the idle cleanup also finds its mappings
    store.saveHistory(thread, room, history);
    history.push({ role: "user", content: anonymizer.anonymize(thread, userText).text });
    const promptProject = project && { id: project.id, title: anonymizer.anonymize(thread, project.title).text };

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

      const messages: Message[] = [{ role: "system", content: systemPrompt(this.#now(), timeZone, mode, promptProject) }, ...history];
      const searchesLeft = run.maxSearches - searches;
      const res = await model.complete({
        model: run.modelName, messages, tools: this.#toolDefs, maxTokens: run.maxTokens,
        ...(searchesLeft > 0 ? { webSearch: { maxSearches: searchesLeft } } : {}),
      });
      cost += res.cost;
      searches += res.searches;
      for (const c of res.citations) if (!sources.has(c.url)) sources.set(c.url, c.title);
      store.logCall({
        thread, model: res.model, promptTokens: res.promptTokens, completionTokens: res.completionTokens, cost: res.cost,
        request: { model: run.modelName, messages }, response: res.message,
      }, this.#now());
      history.push(res.message);

      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        reply = anonymizer.deanonymize(thread, typeof res.message.content === "string" ? res.message.content : "");
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
          result = (await runTool(tools, call.function.name, args)).result;
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
    store.saveHistory(thread, room, trimHistory(history), this.#now().getTime());

    const alert = cost >= limits.alertCost
      ? `This request cost ${credits(cost)}, above the alert threshold of ${credits(limits.alertCost)}.`
      : undefined;
    return finish(reply + sourceList(sources), alert ? { alert } : {});
  }
}
