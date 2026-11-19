import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { choicesText, choiceTools, ProductChoices } from "../src/choices.ts";
import { Store } from "../src/store.ts";
import { runTool } from "../src/tools.ts";

describe("product choices", () => {
  it("remembers one product per item, case-insensitively, newest first, and forgets", () => {
    let now = 1;
    const choices = new ProductChoices(new Store(":memory:", "UTC").db, () => now++);
    choices.remember({ item: "Voda", productId: "111", product: "Magnesia Mg2+ 1,5 l" });
    choices.remember({ item: "mléko", productId: "222", product: "Mléko polotučné 1 l" });
    choices.remember({ item: " voda ", productId: "333", product: "Magnesia Red 1,5 l", note: "6-pack" });
    assert.deepEqual(choices.list().map((c) => [c.item, c.productId, c.note]), [["voda", "333", "6-pack"], ["mléko", "222", undefined]]);
    assert.equal(choices.forget("VODA"), true);
    assert.equal(choices.forget("voda"), false);
    assert.equal(choices.list().length, 1);
  });

  it("tells the model to add remembered products by id", () => {
    assert.equal(choicesText([]), "");
    const text = choicesText([{ item: "voda", productId: "111", product: "Magnesia Mg2+ 1,5 l", note: "6-pack", updatedAt: 1 }]);
    assert.match(text, /add them by product id without searching/);
    assert.match(text, /voda → Magnesia Mg2\+ 1,5 l \(product id 111; 6-pack\)\)$/);
  });

  it("records through the tools, with numeric or string ids, and checks the arguments", async () => {
    const choices = new ProductChoices(new Store(":memory:", "UTC").db);
    const tools = choiceTools(choices);
    assert.deepEqual(await runTool(tools, "remember_product_choice", { item: "voda", product_id: 111, product: "Magnesia" }), { ok: true, result: { remembered: "voda" } });
    assert.equal(choices.list()[0]!.productId, "111");
    assert.equal((await runTool(tools, "remember_product_choice", { item: "voda" })).ok, false);
    assert.deepEqual((await runTool(tools, "forget_product_choice", { item: "pivo" })).result, { error: 'nothing remembered for "pivo"' });
  });
});
