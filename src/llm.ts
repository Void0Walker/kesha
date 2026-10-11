import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export type Message = ChatCompletionMessageParam;

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools: ChatCompletionTool[];
  maxTokens: number;
  // Offer web search in this call, at most this many searches. OpenRouter runs them inside the call
  webSearch?: { maxSearches: number };
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
  // OpenRouter credits (USD), search fees included
  cost: number;
  searches: number;
  citations: Citation[];
}

export interface ChatModel {
  complete(req: CompletionRequest): Promise<Completion>;
}

// Exa through OpenRouter's server tool. Works with ZDR enforced, Firecrawl doesn't. $0.007 per search up to 10 results
const WEB_SEARCH_TOOL = { type: "openrouter:web_search", parameters: { engine: "exa", max_results: 5 } } as const;

interface Usage {
  cost: number;
  cost_details?: { upstream_inference_cost?: number };
}

/** usage.cost included the search fees in one test call and left them out in another. Count them on top of the
 * inference cost, never less than OpenRouter reports, so the caps can only overestimate. */
export function billedCost(usage: Usage, searches: number, searchCost: number): number {
  if (!searches) return usage.cost;
  const inference = usage.cost_details?.upstream_inference_cost ?? usage.cost;
  return Math.max(usage.cost, inference + searches * searchCost);
}

/** OpenRouter through its OpenAI-compatible API. No agent framework: the loop and its caps live in agent.ts. */
export class OpenRouter implements ChatModel {
  readonly #client: OpenAI;
  readonly #zdr: boolean;
  readonly #searchCost: number;

  constructor(apiKey: string, baseURL: string, zdr: boolean, searchCost: number) {
    this.#client = new OpenAI({ apiKey, baseURL, timeout: 120_000, maxRetries: 1 });
    this.#zdr = zdr;
    this.#searchCost = searchCost;
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const body = {
      model: req.model,
      messages: req.messages,
      tools: req.webSearch ? [...req.tools, WEB_SEARCH_TOOL] : req.tools,
      max_tokens: req.maxTokens,
      // OpenRouter extensions: never route to providers that store or train on prompts, bound the searches
      provider: { data_collection: "deny", ...(this.#zdr ? { zdr: true } : {}) },
      ...(req.webSearch ? { max_tool_calls: req.webSearch.maxSearches } : {}),
    };
    const res = await this.#client.chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming);
    const choice = res.choices[0];
    if (!choice) throw new Error("OpenRouter returned no choices");
    const usage = res.usage as (typeof res.usage & Partial<Usage> & { server_tool_use_details?: { web_search_requests?: number } }) | undefined;
    if (usage?.cost === undefined) throw new Error("OpenRouter response has no usage.cost, can't enforce the cost caps");
    const searches = usage.server_tool_use_details?.web_search_requests ?? 0;
    const { content, tool_calls, annotations } = choice.message;
    return {
      message: { role: "assistant", content, ...(tool_calls?.length ? { tool_calls } : {}) },
      model: res.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cost: billedCost({ cost: usage.cost, ...(usage.cost_details ? { cost_details: usage.cost_details } : {}) }, searches, this.#searchCost),
      searches,
      citations: (annotations ?? []).flatMap((a) =>
        a.type === "url_citation" ? [{ url: a.url_citation.url, ...(a.url_citation.title ? { title: a.url_citation.title } : {}) }] : []),
    };
  }
}
