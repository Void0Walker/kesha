import OpenAI from "openai";
import type {
  ChatCompletionChunk, ChatCompletionCreateParamsStreaming, ChatCompletionMessageFunctionToolCall, ChatCompletionMessageParam, ChatCompletionTool,
} from "openai/resources/chat/completions";

export type Message = ChatCompletionMessageParam;

// OpenRouter's reasoning setting: "off" asks the model not to think, unset leaves the model's default
export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools: ChatCompletionTool[];
  maxTokens: number;
  // Offer web search in this call, at most this many searches. OpenRouter runs them inside the call
  webSearch?: { maxSearches: number };
  // Offer opening web pages in this call, at most this many. Only together with webSearch
  webFetch?: { maxFetches: number };
  reasoning?: ReasoningEffort;
  // Keeps one conversation on the provider that holds its prompt cache. Opaque, never a Matrix id
  sessionId?: string;
}

export interface Citation {
  url: string;
  title?: string;
}

export interface Completion {
  message: Extract<Message, { role: "assistant" }>;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  // OpenRouter credits (USD), search fees included
  cost: number;
  searches: number;
  // Pages opened with web fetch, when OpenRouter reports them
  fetches: number;
  citations: Citation[];
}

export interface ChatModel {
  complete(req: CompletionRequest): Promise<Completion>;
}

// Exa through OpenRouter's server tool. Works with ZDR enforced, Firecrawl doesn't. $0.007 per search up to 10 results
const WEB_SEARCH_TOOL = { type: "openrouter:web_search", parameters: { engine: "exa", max_results: 5 } } as const;
// Opens a page through Exa's Contents API (its crawl, so shops that block bots often still work). $0.001 per page.
// Pages are cut to about this many tokens, so one long page can't eat the request's cost cap
const FETCH_MAX_TOKENS = 6000;
export const FETCH_COST = 0.001;
const webFetchTool = (maxUses: number) =>
  ({ type: "openrouter:web_fetch", parameters: { engine: "exa", max_uses: maxUses, max_content_tokens: FETCH_MAX_TOKENS } }) as const;

interface Usage {
  cost: number;
  cost_details?: { upstream_inference_cost?: number };
}

/** usage.cost included the search fees in one test call and left them out in another. Count the server tool fees
 * (searches, fetches) on top of the inference cost, never less than OpenRouter reports, so the caps can only
 * overestimate. */
export function billedCost(usage: Usage, toolFees: number): number {
  if (!toolFees) return usage.cost;
  const inference = usage.cost_details?.upstream_inference_cost ?? usage.cost;
  return Math.max(usage.cost, inference + toolFees);
}

// full: cache the system prompt and the conversation so far. system: only the system prompt
export type PromptCache = "full" | "system" | "off";

const EPHEMERAL = { type: "ephemeral" } as const;

/** Anthropic models only cache with explicit markers; others (DeepSeek) cache by themselves. The markers are added
 * to a copy for the request and never stored, so history never collects more than Anthropic's four breakpoints. */
export function withCacheControl(model: string, messages: Message[], mode: PromptCache): { messages: unknown[]; topLevel?: typeof EPHEMERAL } {
  if (mode === "off" || !model.startsWith("anthropic/")) return { messages };
  const out = messages.map((m) =>
    m.role === "system" && typeof m.content === "string"
      ? { role: "system", content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] }
      : m,
  );
  return mode === "full" ? { messages: out, topLevel: EPHEMERAL } : { messages: out };
}

export interface OpenRouterOptions {
  apiKey: string;
  baseURL: string;
  zdr: boolean;
  searchCost: number;
  promptCache: PromptCache;
  // Tests: a fake fetch and short timeouts
  fetch?: typeof fetch;
  idleTimeoutMs?: number;
  callTimeoutMs?: number;
}

// Until OpenRouter answers with headers. Only this part is retried: nothing has run or been billed yet
const HEADERS_TIMEOUT_MS = 60_000;
// Streamed, a call fails only when the model goes quiet, not because searches, pages and reasoning take long
const IDLE_TIMEOUT_MS = 120_000;
// A stream that trickles forever still ends
const CALL_TIMEOUT_MS = 300_000;

/** The model stopped sending (or never finished). OpenRouter cancels the call upstream when the stream is dropped. */
export class ModelTimeoutError extends Error {}

type ToolUse = { web_search_requests?: number; web_fetch_requests?: number };
type StreamUsage = NonNullable<ChatCompletionChunk["usage"]> & Partial<Usage> & { server_tool_use_details?: ToolUse; server_tool_use?: ToolUse };
// OpenRouter's extensions to a streamed delta
type ReasoningDetail = { index?: number; type?: string; [k: string]: unknown };
type Annotation = { type: string; url_citation?: { url: string; title?: string } };
type Delta = ChatCompletionChunk.Choice.Delta & { reasoning_details?: ReasoningDetail[]; annotations?: Annotation[] };

/** Reasoning arrives in pieces per index (the docs only say "concatenate in order"): text is appended, the rest
 * (signature, format) is set once. Pieces with different ids stay separate blocks. */
function mergeReasoning(into: ReasoningDetail[], d: ReasoningDetail): void {
  const prev = d.index === undefined
    ? undefined
    : into.find((x) => x.index === d.index && x.type === d.type && (x.id === undefined || d.id === undefined || x.id === d.id));
  if (!prev) {
    into.push({ ...d });
    return;
  }
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    prev[k] = (k === "text" || k === "summary" || k === "data") && typeof v === "string" ? `${(prev[k] as string | undefined) ?? ""}${v}` : v;
  }
}

/** Collects a streamed answer into the message a non-streamed call would have returned. */
class StreamedAnswer {
  model = "";
  content = "";
  sawChoice = false;
  finishReason: string | null = null;
  usage: StreamUsage | undefined;
  readonly toolCalls = new Map<number, ChatCompletionMessageFunctionToolCall>();
  readonly reasoning: ReasoningDetail[] = [];
  readonly annotations: Annotation[] = [];

  add(chunk: ChatCompletionChunk): void {
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage as StreamUsage;
    const choice = chunk.choices[0];
    if (!choice) return;
    this.sawChoice = true;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta as Delta | undefined;
    if (!delta) return;
    if (delta.content) this.content += delta.content;
    for (const t of delta.tool_calls ?? []) {
      const call = this.toolCalls.get(t.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (t.id) call.id = t.id;
      if (t.function?.name) call.function.name += t.function.name;
      if (t.function?.arguments) call.function.arguments += t.function.arguments;
      this.toolCalls.set(t.index, call);
    }
    for (const d of delta.reasoning_details ?? []) mergeReasoning(this.reasoning, d);
    this.annotations.push(...(delta.annotations ?? []));
  }
}

/** OpenRouter through its OpenAI-compatible API. No agent framework: the loop and its caps live in agent.ts. */
export class OpenRouter implements ChatModel {
  readonly #client: OpenAI;
  readonly #o: OpenRouterOptions;

  constructor(o: OpenRouterOptions) {
    this.#client = new OpenAI({
      apiKey: o.apiKey, baseURL: o.baseURL, timeout: HEADERS_TIMEOUT_MS, maxRetries: 1, ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    this.#o = o;
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const cached = withCacheControl(req.model, req.messages, this.#o.promptCache);
    const body = {
      model: req.model,
      messages: cached.messages,
      tools: [
        ...req.tools,
        ...(req.webSearch ? [{ ...WEB_SEARCH_TOOL, parameters: { ...WEB_SEARCH_TOOL.parameters, max_uses: req.webSearch.maxSearches } }] : []),
        ...(req.webSearch && req.webFetch ? [webFetchTool(req.webFetch.maxFetches)] : []),
      ],
      max_tokens: req.maxTokens,
      // Streamed so a long call (searches, opened pages, reasoning) isn't mistaken for a dead one; usage comes last
      stream: true,
      stream_options: { include_usage: true },
      // OpenRouter extensions: never route to providers that store or train on prompts, bound the server tools
      // (max_tool_calls is shared by search and fetch, max_uses caps each)
      provider: { data_collection: "deny", ...(this.#o.zdr ? { zdr: true } : {}) },
      ...(req.webSearch ? { max_tool_calls: req.webSearch.maxSearches + (req.webFetch?.maxFetches ?? 0) } : {}),
      ...(req.reasoning ? { reasoning: req.reasoning === "off" ? { enabled: false } : { effort: req.reasoning } } : {}),
      ...(cached.topLevel ? { cache_control: cached.topLevel } : {}),
      ...(req.sessionId ? { session_id: req.sessionId } : {}),
    };
    const answer = await this.#stream(body as unknown as ChatCompletionCreateParamsStreaming);
    if (!answer.sawChoice) throw new Error("OpenRouter returned no choices");
    if (answer.finishReason === "error") throw new Error("OpenRouter ended the stream with an error");
    const usage = answer.usage;
    if (usage?.cost === undefined) throw new Error("OpenRouter response has no usage.cost, can't enforce the cost caps");
    // The docs name it server_tool_use, responses seen so far server_tool_use_details
    const toolUse = usage.server_tool_use_details ?? usage.server_tool_use;
    const searches = toolUse?.web_search_requests ?? 0;
    const fetches = toolUse?.web_fetch_requests ?? 0;
    const toolCalls = [...answer.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    return {
      message: {
        role: "assistant", content: answer.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        // Thinking models need their reasoning back on tool-call continuations within a turn
        ...(answer.reasoning.length ? { reasoning_details: answer.reasoning } : {}),
      } as Completion["message"],
      model: answer.model || req.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      cost: billedCost({ cost: usage.cost, ...(usage.cost_details ? { cost_details: usage.cost_details } : {}) },
        searches * this.#o.searchCost + fetches * FETCH_COST),
      searches,
      fetches,
      citations: answer.annotations.flatMap((a) =>
        a.type === "url_citation" && a.url_citation ? [{ url: a.url_citation.url, ...(a.url_citation.title ? { title: a.url_citation.title } : {}) }] : []),
    };
  }

  /** Reads the stream with a watchdog: dropped when nothing arrives for the idle timeout, or the call takes too long.
   * Never retried once streaming: the searches would run, and be paid, again. */
  async #stream(body: ChatCompletionCreateParamsStreaming): Promise<StreamedAnswer> {
    const idleMs = this.#o.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    const callMs = this.#o.callTimeoutMs ?? CALL_TIMEOUT_MS;
    const stream = await this.#client.chat.completions.create(body);
    const answer = new StreamedAnswer();
    let timedOut: string | undefined;
    const stop = (why: string) => {
      timedOut = why;
      stream.controller.abort();
    };
    const deadline = setTimeout(() => stop(`the model didn't finish within ${callMs / 1000} s`), callMs);
    const idle = setTimeout(() => stop(`the model sent nothing for ${idleMs / 1000} s`), idleMs);
    try {
      for await (const chunk of stream) {
        idle.refresh();
        answer.add(chunk);
      }
    } catch (e) {
      if (timedOut) throw new ModelTimeoutError(timedOut, { cause: e });
      throw e;
    } finally {
      clearTimeout(idle);
      clearTimeout(deadline);
    }
    // Aborted between chunks, the iterator can end quietly instead of throwing
    if (timedOut) throw new ModelTimeoutError(timedOut);
    return answer;
  }
}
