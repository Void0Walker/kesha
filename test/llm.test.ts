import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billedCost, withCacheControl, type Message } from "../src/llm.ts";

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
