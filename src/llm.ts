import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export type Message = ChatCompletionMessageParam;

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools: ChatCompletionTool[];
  maxTokens: number;
}

export interface Completion {
  message: Extract<Message, { role: "assistant" }>;
  model: string;
  promptTokens: number;
  completionTokens: number;
  // OpenRouter credits (USD)
  cost: number;
}

export interface ChatModel {
  complete(req: CompletionRequest): Promise<Completion>;
}

/** OpenRouter through its OpenAI-compatible API. No agent framework: the loop and its caps live in agent.ts. */
export class OpenRouter implements ChatModel {
  readonly #client: OpenAI;
  readonly #zdr: boolean;

  constructor(apiKey: string, baseURL: string, zdr: boolean) {
    this.#client = new OpenAI({ apiKey, baseURL, timeout: 120_000, maxRetries: 1 });
    this.#zdr = zdr;
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const res = await this.#client.chat.completions.create({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      max_tokens: req.maxTokens,
      // OpenRouter extensions: never route to providers that store or train on prompts
      // @ts-expect-error not part of the OpenAI request type
      provider: { data_collection: "deny", ...(this.#zdr ? { zdr: true } : {}) },
    });
    const choice = res.choices[0];
    if (!choice) throw new Error("OpenRouter returned no choices");
    const usage = res.usage as (typeof res.usage & { cost?: number }) | undefined;
    if (usage?.cost === undefined) throw new Error("OpenRouter response has no usage.cost, can't enforce the cost caps");
    const { content, tool_calls } = choice.message;
    return {
      message: { role: "assistant", content, ...(tool_calls?.length ? { tool_calls } : {}) },
      model: res.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cost: usage.cost,
    };
  }
}
