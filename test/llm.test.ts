import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billedCost } from "../src/llm.ts";

// Shapes seen from OpenRouter with the Exa web search server tool (2026-10-11)
describe("billedCost", () => {
  it("takes the reported cost when nothing was searched", () => {
    assert.equal(billedCost({ cost: 0.002, cost_details: { upstream_inference_cost: 0.002 } }, 0, 0.007), 0.002);
  });

  it("keeps the reported cost when it already includes the search fees", () => {
    assert.equal(billedCost({ cost: 0.0134, cost_details: { upstream_inference_cost: 0.0064 } }, 1, 0.007), 0.0134);
  });

  it("adds the search fees when the reported cost leaves them out", () => {
    assert.ok(Math.abs(billedCost({ cost: 0.0111, cost_details: { upstream_inference_cost: 0.0111 } }, 2, 0.007) - 0.0251) < 1e-12);
  });

  it("adds them on top of the reported cost when there is no breakdown", () => {
    assert.ok(Math.abs(billedCost({ cost: 0.01 }, 1, 0.007) - 0.017) < 1e-12);
  });
});
