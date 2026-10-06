import { Anonymizer, UnknownPlaceholderError } from "./anonymizer.ts";
import type { ChatModel, Message } from "./llm.ts";
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

export interface AgentDeps {
  model: ChatModel;
  modelName: string;
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
  // Set when the request crossed the alert threshold
  alert?: string;
  // Vikunja rejected the token itself: tell the user loudly, stop using Vikunja
  tokenDead?: boolean;
}

// Older messages are dropped from the thread history beyond this, cut at a user message
const MAX_HISTORY = 40;

const credits = (n: number) => `$${n.toFixed(4)}`;

function systemPrompt(now: Date, timeZone: string): string {
  const local = now.toLocaleString("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" });
  return [
    "You are Kesha, a concise assistant that manages the user's tasks in Vikunja through the tools you have.",
    `Now: ${local} (${timeZone}). Resolve relative dates ("tomorrow", "Friday") against this, and give due dates with the UTC offset of ${timeZone}.`,
    "Names, places, emails and similar details are replaced by placeholders like <PERSON_1> or <EMAIL_2>. Treat each placeholder as the real value: use it as-is in tool arguments and replies, never invent new ones, never ask what it stands for.",
    "Some tasks are private. You can't see or change them; if a tool says a task is private, tell the user to handle it in Vikunja themselves.",
    "Before changing or creating tasks, look up ids with the tools instead of guessing. After a change, confirm briefly what was done.",
    "There is no delete tool. If the user wants a task deleted, mark it done or tell them to delete it in Vikunja.",
    "Reply in the user's language. Keep replies short, plain text, no Markdown tables.",
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

  spentToday(): number {
    const { store } = this.#d;
    return store.spentOn(store.today(this.#now()));
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date();
  }

  async turn(thread: string, room: string, userText: string): Promise<TurnResult> {
    const { model, modelName, anonymizer, store, limits, tools, timeZone } = this.#d;

    const spent = this.spentToday();
    if (spent >= limits.dailyCap) {
      return { reply: `Today's budget is used up (${credits(spent)} of ${credits(limits.dailyCap)}). I'm back tomorrow.`, cost: 0 };
    }

    const history = store.getHistory(thread) as Message[];
    // Record the thread before anything is pseudonymized, so the idle cleanup also finds its mappings
    store.saveHistory(thread, room, history);
    history.push({ role: "user", content: anonymizer.anonymize(thread, userText).text });

    let cost = 0;
    let reply: string | undefined;
    for (let step = 0; step < limits.maxSteps; step++) {
      if (cost >= limits.maxCostPerRequest) {
        reply = `I stopped: this request reached the cost limit of ${credits(limits.maxCostPerRequest)} before I was done.`;
        break;
      }
      if (spent + cost >= limits.dailyCap) {
        reply = `I stopped: today's budget of ${credits(limits.dailyCap)} is used up.`;
        break;
      }

      const messages: Message[] = [{ role: "system", content: systemPrompt(this.#now(), timeZone) }, ...history];
      const res = await model.complete({ model: modelName, messages, tools: this.#toolDefs, maxTokens: limits.maxTokens });
      cost += res.cost;
      store.logCall({
        thread, model: res.model, promptTokens: res.promptTokens, completionTokens: res.completionTokens, cost: res.cost,
        request: { model: modelName, messages }, response: res.message,
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
          result = (await runTool(tools, call.function.name, args)).result;
        } catch (e) {
          if (e instanceof VikunjaAuthError) {
            return { reply: "Vikunja rejected my token: it expired or was revoked. Rotate it (README, \"Rotating the Kesha Vikunja token\"). Nothing was changed.", cost, tokenDead: true };
          }
          if (e instanceof SyntaxError) result = { error: "arguments are not valid JSON" };
          else if (e instanceof UnknownPlaceholderError) result = { error: e.message };
          else throw e;
        }
        history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(anonymizer.anonymizeValue(thread, result)) });
      }
    }

    if (reply === undefined) reply = `I stopped after ${limits.maxSteps} steps without finishing. Try a narrower request.`;
    if (history.at(-1)?.role !== "assistant") history.push({ role: "assistant", content: anonymizer.anonymize(thread, reply).text });
    store.saveHistory(thread, room, trimHistory(history), this.#now().getTime());

    const alert = cost >= limits.alertCost
      ? `This request cost ${credits(cost)}, above the alert threshold of ${credits(limits.alertCost)}.`
      : undefined;
    return { reply, cost, ...(alert ? { alert } : {}) };
  }
}
