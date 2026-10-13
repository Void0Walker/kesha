import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billedCost, ModelTimeoutError, OpenRouter, withCacheControl, type Message, type OpenRouterOptions } from "../src/llm.ts";

// Shapes seen from OpenRouter with the Exa web search server tool (2026-10-11)
describe("billedCost", () => {
  it("takes the reported cost when nothing was searched", () => {
    assert.equal(billedCost({ cost: 0.002, cost_details: { upstream_inference_cost: 0.002 } }, 0), 0.002);
  });

  it("keeps the reported cost when it already includes the search fees", () => {
    assert.equal(billedCost({ cost: 0.0134, cost_details: { upstream_inference_cost: 0.0064 } }, 0.007), 0.0134);
  });

  it("adds the search fees when the reported cost leaves them out", () => {
    assert.ok(Math.abs(billedCost({ cost: 0.0111, cost_details: { upstream_inference_cost: 0.0111 } }, 2 * 0.007) - 0.0251) < 1e-12);
  });

  it("adds them on top of the reported cost when there is no breakdown", () => {
    assert.ok(Math.abs(billedCost({ cost: 0.01 }, 0.007) - 0.017) < 1e-12);
  });
});

describe("withCacheControl", () => {
  const messages: Message[] = [{ role: "system", content: "You are Kesha." }, { role: "user", content: "hi" }];

  it("marks the system prompt and the tail for Anthropic models, on a copy", () => {
    const r = withCacheControl("anthropic/claude-haiku-5.5", messages, "full");
    assert.deepEqual(r.messages[0], { role: "system", content: [{ type: "text", text: "You are Kesha.", cache_control: { type: "ephemeral" } }] });
    assert.deepEqual(r.messages[1], messages[1]);
    assert.deepEqual(r.topLevel, { type: "ephemeral" });
    // The stored history must never collect markers
    assert.equal(messages[0]!.content, "You are Kesha.");
  });

  it("marks only the system prompt in system mode", () => {
    assert.equal(withCacheControl("anthropic/claude-haiku-5.5", messages, "system").topLevel, undefined);
  });

  it("leaves other models and the off mode alone", () => {
    assert.deepEqual(withCacheControl("deepseek/deepseek-v4-pro", messages, "full"), { messages });
    assert.deepEqual(withCacheControl("anthropic/claude-haiku-5.5", messages, "off"), { messages });
  });
});

// A fake OpenRouter that streams the given chunks as server-sent events, pausing pauseMs before each
function sse(chunks: unknown[], o: { pauseMs?: number; comments?: boolean } = {}) {
  const bodies: unknown[] = [];
  const enc = new TextEncoder();
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const signal = init.signal!;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const chunk of [...chunks, "[DONE]"]) {
          if (o.pauseMs) await new Promise((r) => setTimeout(r, o.pauseMs));
          if (signal.aborted) return c.error(signal.reason);
          if (o.comments) c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
          c.enqueue(enc.encode(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`));
        }
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fakeFetch, bodies };
}

const chunk = (delta: object, extra: object = {}) => ({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: "deepseek/deepseek-v4-pro", choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const usageChunk = (usage: object) => ({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: "deepseek/deepseek-v4-pro", choices: [], usage });
const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.002 };

function client(fakeFetch: typeof fetch, o: Partial<OpenRouterOptions> = {}) {
  return new OpenRouter({ apiKey: "k", baseURL: "http://openrouter.test/api/v1", zdr: true, searchCost: 0.007, promptCache: "off", fetch: fakeFetch, ...o });
}
const request = { model: "deepseek/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] as Message[], tools: [], maxTokens: 100 };

describe("OpenRouter streaming", () => {
  it("puts text, tool calls, reasoning, citations and cost back together", async () => {
    const { fakeFetch, bodies } = sse([
      chunk({ role: "assistant", reasoning_details: [{ type: "reasoning.text", index: 0, text: "Let me " }] }),
      chunk({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "think.", signature: "sig" }] }),
      chunk({ content: "Kettles: " }),
      chunk({ content: "see below.", annotations: [{ type: "url_citation", url_citation: { url: "https://example.com/k", title: "Kettle" } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "create_task", arguments: '{"title":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Buy kettle"}' } }] }),
      chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      usageChunk({ ...USAGE, cost: 0.0111, cost_details: { upstream_inference_cost: 0.0111 }, server_tool_use_details: { web_search_requests: 2 } }),
    ]);
    const res = await client(fakeFetch).complete({ ...request, webSearch: { maxSearches: 6 } });
    assert.deepEqual(res.message, {
      role: "assistant", content: "Kettles: see below.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "create_task", arguments: '{"title":"Buy kettle"}' } }],
      reasoning_details: [{ type: "reasoning.text", index: 0, text: "Let me think.", signature: "sig" }],
    });
    assert.deepEqual(res.citations, [{ url: "https://example.com/k", title: "Kettle" }]);
    assert.equal(res.searches, 2);
    assert.ok(Math.abs(res.cost - 0.0251) < 1e-12);
    assert.equal(res.model, "deepseek/deepseek-v4-pro");
    assert.equal((bodies[0] as { stream: boolean }).stream, true);
  });

  it("leaves content null for a pure tool call", async () => {
    const { fakeFetch } = sse([chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "list_tasks", arguments: "{}" } }] }), usageChunk(USAGE)]);
    const res = await client(fakeFetch).complete(request);
    assert.equal(res.message.content, null);
  });

  it("refuses an answer without usage.cost", async () => {
    const { fakeFetch } = sse([chunk({ content: "hi" })]);
    await assert.rejects(client(fakeFetch).complete(request), /no usage\.cost/);
  });

  it("surfaces an error sent in the middle of the stream", async () => {
    const { fakeFetch } = sse([chunk({ content: "hi" }), { error: { code: 502, message: "Provider disconnected" } }]);
    await assert.rejects(client(fakeFetch).complete(request), /Provider disconnected/);
  });

  it("waits as long as data keeps coming", async () => {
    const { fakeFetch } = sse([chunk({ content: "a" }), chunk({ content: "b" }), chunk({ content: "c" }), usageChunk(USAGE)], { pauseMs: 30 });
    const res = await client(fakeFetch, { idleTimeoutMs: 80 }).complete(request);
    assert.equal(res.message.content, "abc");
  });

  it("gives up when the model goes quiet, keep-alive comments don't count", async () => {
    const { fakeFetch, bodies } = sse([chunk({ content: "a" }), usageChunk(USAGE)], { pauseMs: 100, comments: true });
    await assert.rejects(client(fakeFetch, { idleTimeoutMs: 40 }).complete(request), (e) => e instanceof ModelTimeoutError && /sent nothing for 0.04 s/.test(e.message));
    // Not retried: a retry would run the searches again
    assert.equal(bodies.length, 1);
  });

  it("gives up on a call that trickles past the call timeout", async () => {
    const { fakeFetch } = sse([chunk({ content: "a" }), chunk({ content: "b" }), chunk({ content: "c" }), usageChunk(USAGE)], { pauseMs: 30 });
    await assert.rejects(client(fakeFetch, { idleTimeoutMs: 1000, callTimeoutMs: 70 }).complete(request), (e) => e instanceof ModelTimeoutError && /didn't finish within/.test(e.message));
  });
});
