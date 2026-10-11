import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent, compactHistory, costFooter, sentAt, snapshotText, trimHistory, type Limits, type ResearchProfile } from "../src/agent.ts";
import type { Message } from "../src/llm.ts";
import { Anonymizer, parseDictionary } from "../src/anonymizer.ts";
import { Store } from "../src/store.ts";
import { createTools, openTasks } from "../src/tools.ts";
import { undoLast } from "../src/undo.ts";
import { runCommand } from "../src/commands.ts";
import { currentConversation } from "../src/conversation.ts";
import { VikunjaAuthError } from "../src/vikunja.ts";
import { FakeVikunja, say, ScriptedModel, toolCall } from "./fakes.ts";

const DICT = "people:\n  - names: [Jana Nováková, Jana]\n    forms: [Janě, Jany]\n";
const LIMITS: Limits = { maxSteps: 5, maxTokens: 500, maxCostPerRequest: 0.05, alertCost: 0.02, dailyCap: 1 };
const NOW = new Date("2026-10-06T10:00:00Z");

const RESEARCH: ResearchProfile = { modelName: "test/research", maxSteps: 4, maxTokens: 2000, maxCostPerRequest: 0.2, maxSearches: 3 };

function setup(model: ScriptedModel, limits: Partial<Limits> = {}, research?: ResearchProfile, letters?: ResearchProfile) {
  const store = new Store(":memory:", "Europe/Berlin");
  const v = new FakeVikunja();
  const listOpenTasks = async (projectId: number) => (await openTasks(v, projectId, 2)).tasks;
  const anonymizer = new Anonymizer(parseDictionary(DICT), store);
  const agent = new Agent({
    model, modelName: "test/model", tools: createTools(v, 1, (t) => anonymizer.variants(t)), anonymizer, listOpenTasks,
    store, limits: { ...LIMITS, ...limits }, timeZone: "Europe/Berlin", now: () => NOW, ...(research ? { research } : {}), ...(letters ? { letters } : {}),
  });
  return { store, v, agent };
}

describe("agent", () => {
  it("never sends names to the model, and writes the real names to Vikunja", async () => {
    const model = new ScriptedModel([
      toolCall("list_tasks", { search: "<PERSON_1>" }),
      (req) => {
        // The tool result about Jana comes back pseudonymized too
        assert.match(String(req.messages.at(-1)!.content), /<PERSON_1>/);
        return toolCall("create_task", { title: "Call <PERSON_1> about the gift" });
      },
      say("Done, I added a task to call <PERSON_1>."),
    ]);
    const { v, agent } = setup(model);
    v.add({ title: "Gift for Jana", description: "<p>Jany favourite: tea</p>" });

    const res = await agent.turn("thread1", "!room", "Remind me to call Janě about the gift");

    assert.equal(res.reply, "Done, I added a task to call Jana Nováková.");
    assert.doesNotMatch(model.sent(), /Jan[aěy]|Nováková/);
    assert.ok([...v.tasks.values()].some((t) => t.title === "Call Jana Nováková about the gift"));
  });

  it("logs every call with its cost and the pseudonymized request", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects.")], 0.004);
    const { store, agent } = setup(model);
    const res = await agent.turn("t", "!room", "Which projects do I have, Jana?");
    assert.equal(res.cost, 0.008);
    const rows = store.db.prepare("SELECT model, cost, request FROM calls").all() as { model: string; cost: number; request: string }[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.model === "test/model" && r.cost === 0.004));
    assert.doesNotMatch(rows.map((r) => r.request).join(), /Jana/);
    assert.equal(store.spentOn("2026-10-06"), 0.008);
  });

  it("stops calling the model once a request hits its cost cap", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), toolCall("list_projects", {}), say("never reached")], 0.03);
    const { agent } = setup(model);
    const res = await agent.turn("t", "!room", "loop");
    assert.equal(model.requests.length, 2);
    assert.match(res.reply, /cost limit/);
    assert.match(res.alert ?? "", /alert threshold/);
  });

  it("refuses without calling the model once the daily cap is reached", async () => {
    const model = new ScriptedModel([say("never")]);
    const { store, agent } = setup(model, { dailyCap: 0.01 });
    store.logCall({ thread: "x", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.01, request: {}, response: {} }, NOW);
    const res = await agent.turn("t", "!room", "hi");
    assert.equal(model.requests.length, 0);
    assert.match(res.reply, /budget is used up/);
  });

  it("stops after the step limit", async () => {
    const model = new ScriptedModel(Array.from({ length: 5 }, () => toolCall("list_projects", {})), 0);
    const { agent } = setup(model);
    const res = await agent.turn("t", "!room", "loop");
    assert.equal(model.requests.length, 5);
    assert.match(res.reply, /after 5 steps/);
  });

  it("returns tool errors to the model instead of failing", async () => {
    const model = new ScriptedModel([
      toolCall("create_task", { title: "Call <PERSON_9>" }),
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /unknown placeholder/);
        return toolCall("update_task", { id: 1 });
      },
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /at least one field/);
        return say("Sorry.");
      },
    ]);
    const { v, agent } = setup(model);
    const res = await agent.turn("t", "!room", "do it");
    assert.equal(res.reply, "Sorry.");
    assert.equal(v.writes.length, 0);
  });

  it("refuses to write the provider's redaction labels into Vikunja", async () => {
    const model = new ScriptedModel([
      toolCall("create_task", { title: "Call [PERSON_NAME] at [PHONE]" }),
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /\[PERSON_NAME\], \[PHONE\] was removed by the provider/);
        return toolCall("update_task", { id: 1, description: "Notes: [SECRET:github-token]" });
      },
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /\[SECRET:github-token\] was removed/);
        return say("I couldn't see the name, please tell me who to call.");
      },
    ]);
    const { v, agent } = setup(model);
    v.add({ title: "Existing" });
    const res = await agent.turn("t", "!room", "add a task");
    assert.equal(v.writes.length, 0);
    assert.match(res.reply, /couldn't see the name/);
  });

  it("still writes square brackets that aren't redaction labels", async () => {
    const model = new ScriptedModel([toolCall("create_task", { title: "[WIP] Fix bike" }), say("Added.")]);
    const { v, agent } = setup(model);
    await agent.turn("t", "!room", "add [WIP] Fix bike");
    assert.equal(v.writes.length, 1);
  });

  it("keeps the conversation per thread, pseudonymized", async () => {
    const model = new ScriptedModel([say("Noted."), say("You asked about <PERSON_1>.")]);
    const { store, agent } = setup(model);
    await agent.turn("t", "!room", "Jana's birthday is soon");
    await agent.turn("t", "!room", "What did I ask?");
    const second = model.requests[1]!.messages.map((m) => m.content);
    const at = "[Tue 2026-10-06 12:00 +02:00]";
    assert.deepEqual(second.slice(1), [`${at} <PERSON_1>'s birthday is soon`, "Noted.", `${at} What did I ask?`]);
    assert.doesNotMatch(JSON.stringify(store.getHistory("t")), /Jana/);
  });

  it("reports a dead Vikunja token", async () => {
    const model = new ScriptedModel([toolCall("list_tasks", {})]);
    const { v, agent } = setup(model);
    v.listTasks = async () => {
      throw new VikunjaAuthError();
    };
    const res = await agent.turn("t", "!room", "what's open?");
    assert.ok(res.tokenDead);
    assert.match(res.reply, /expired or was revoked/);
  });

  it("forgets idle threads with their mappings", async () => {
    const model = new ScriptedModel([say("ok")]);
    const { store, agent } = setup(model);
    await agent.turn("old", "!room", "Jana");
    assert.equal(store.forgetIdleThreads(1000, NOW.getTime() + 2000), 1);
    assert.equal(store.lookupPlaceholder("old", "<PERSON_1>"), undefined);
  });
});

describe("research", () => {
  it("uses the research model with web search, lists sources and counts searches", async () => {
    const model = new ScriptedModel([
      (req) => {
        assert.equal(req.model, "test/research");
        assert.deepEqual(req.webSearch, { maxSearches: 3 });
        assert.match(String(req.messages[0]!.content), /search the web/);
        return {
          ...say("Node 24 is the current LTS, supported until April 2028."), searches: 2, cost: 0.02,
          citations: [{ url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases" }, { url: "https://example.org/eol" }],
        };
      },
    ]);
    const { agent } = setup(model, {}, RESEARCH);
    const res = await agent.turn("t", "!room", "Which Node.js version is LTS?", "research");
    assert.equal(res.reply, [
      "Node 24 is the current LTS, supported until April 2028.",
      "",
      "Sources:",
      "1. Node.js Releases — https://nodejs.org/en/about/previous-releases",
      "2. https://example.org/eol",
    ].join("\n"));
    assert.equal(res.searches, 2);
    assert.equal(res.footer, "— $0.0200 · 2 searches · today $0.0200 of $1.00");
  });

  it("stops offering web search once the request used its searches", async () => {
    const model = new ScriptedModel([
      { ...toolCall("list_projects", {}), searches: 3 },
      (req) => {
        assert.equal(req.webSearch, undefined);
        return say("Done.");
      },
    ]);
    const { agent } = setup(model, {}, RESEARCH);
    const res = await agent.turn("t", "!room", "dig deep", "research");
    assert.equal(res.searches, 3);
  });

  it("applies the research cost cap instead of the task one", async () => {
    // 0.06 per call is over the task cap (0.05) after one call, and over the research cap (0.2) after the fourth
    const model = new ScriptedModel(Array.from({ length: 6 }, () => toolCall("list_projects", {})), 0.06);
    const { agent } = setup(model, {}, { ...RESEARCH, maxSteps: 6 });
    const res = await agent.turn("t", "!room", "loop", "research");
    assert.equal(model.requests.length, 4);
    assert.match(res.reply, /cost limit of \$0\.2000/);
  });

  it("never offers web search in task threads", async () => {
    const model = new ScriptedModel([(req) => (assert.equal(req.webSearch, undefined), say("ok"))]);
    const { agent } = setup(model, {}, RESEARCH);
    await agent.turn("t", "!room", "hi");
  });

  it("says so when research is not configured", async () => {
    const model = new ScriptedModel([]);
    const { agent } = setup(model);
    const res = await agent.turn("t", "!room", "anything", "research");
    assert.equal(model.requests.length, 0);
    assert.match(res.reply, /KESHA_RESEARCH_MODEL/);
    assert.equal(res.footer, undefined);
  });

  it("forgets ended conversations early and keeps the current ones", async () => {
    const { store, agent } = setup(new ScriptedModel([say("ok"), say("ok")]));
    await agent.turn("!room#1", "!room", "Jana");
    await agent.turn("!room#2", "!room", "Jana");
    assert.equal(store.forgetEndedConversations(new Set(["!room#2"]), 3_600_000, NOW.getTime() + 2 * 3_600_000), 1);
    assert.equal(store.lookupPlaceholder("!room#1", "<PERSON_1>"), undefined);
    assert.match(store.lookupPlaceholder("!room#2", "<PERSON_1>") ?? "", /Jana Nováková/);
  });
});

describe("decisions", () => {
  it("records a decision as an open task in the room's project", async () => {
    const model = new ScriptedModel([
      (req) => {
        assert.match(String(req.messages[0]!.content), /note or record a decision, create one open task \(not done\)/);
        return toolCall("create_task", { title: "Decision: Bosch dishwasher", description: "Quieter, fits the niche. Ruled out: Miele (price). 2026-10-06" });
      },
      say("Noted the decision."),
    ]);
    const { v, agent } = setup(model);
    await agent.turn("t", "!room", "note that decision", "task", { id: 2, title: "Home appliances" });
    const task = [...v.tasks.values()].find((t) => t.title === "Decision: Bosch dishwasher")!;
    assert.equal(task.done, false);
    assert.equal(task.project_id, 2);
  });

  it("creates a task as done when asked, also when Vikunja ignores done on create", async () => {
    const model = new ScriptedModel([toolCall("create_task", { title: "Paid the electricity bill", done: true }), say("Logged.")]);
    const { v, agent } = setup(model);
    const create = v.createTask.bind(v);
    v.createTask = (pid, fields) => create(pid, { ...fields, done: false });
    await agent.turn("t", "!room", "log that I already paid the electricity bill");
    assert.equal([...v.tasks.values()][0]!.done, true);
  });
});

describe("room project", () => {
  it("puts new tasks into the room's project unless the model names one, and pseudonymizes its title", async () => {
    const model = new ScriptedModel([
      (req) => {
        assert.match(String(req.messages[0]!.content), /belongs to the project "<PERSON_1>'s room" \(id 2\)/);
        return toolCall("create_task", { title: "Descale kettle" });
      },
      toolCall("create_task", { title: "Pay rent", project_id: 1 }, "call_2"),
      say("Done."),
    ]);
    const { v, agent } = setup(model);
    await agent.turn("t", "!room", "add two tasks", "task", { id: 2, title: "Jana's room" });
    assert.deepEqual(v.writes.map((w) => (w.body as { projectId: number }).projectId), [2, 1]);
    assert.doesNotMatch(model.sent(), /Jana/);
  });
});

describe("cost footer", () => {
  it("shows the request cost and today's total on task replies", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects.")], 0.004);
    const { store, agent } = setup(model);
    store.logCall({ thread: "x", model: "m", promptTokens: 1, completionTokens: 1, cost: 0.1, request: {}, response: {} }, NOW);
    const res = await agent.turn("t", "!room", "Which projects?");
    assert.equal(res.footer, "— $0.0080 · today $0.1080 of $1.00");
  });

  it("formats one search in the singular", () => {
    assert.equal(costFooter(0.0134, 1, 0.5, 2), "— $0.0134 · 1 search · today $0.5000 of $2.00");
  });
});

describe("token savings", () => {
  it("sends byte-identical system prompts and the same session id in every call of a conversation", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects (#1, #2)."), say("Sure.")]);
    const { agent } = setup(model);
    await agent.turn("t", "!room", "Which projects, Jana?");
    await agent.turn("t", "!room", "thanks");
    const systems = new Set(model.requests.map((r) => JSON.stringify(r.messages[0])));
    assert.equal(systems.size, 1);
    assert.doesNotMatch([...systems][0]!, /2026-10-06|Now:/);
    const sessions = new Set(model.requests.map((r) => r.sessionId));
    assert.equal(sessions.size, 1);
    assert.match([...sessions][0]!, /^[0-9a-f]{32}$/);
  });

  it("drops earlier tool calls and results from later turns", async () => {
    const model = new ScriptedModel([toolCall("list_projects", {}), say("Two projects."), say("ok")]);
    const { store, agent } = setup(model);
    await agent.turn("t", "!room", "Which projects?");
    await agent.turn("t", "!room", "and now?");
    const roles = model.requests[2]!.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
    assert.ok((store.getHistory("t") as Message[]).every((m) => m.role !== "tool"));
  });

  it("replaces an empty reply instead of storing an empty assistant message", async () => {
    const model = new ScriptedModel([say("")]);
    const { store, agent } = setup(model);
    const res = await agent.turn("t", "!room", "hi");
    assert.match(res.reply, /no answer/);
    const last = (store.getHistory("t") as Message[]).at(-1)!;
    assert.equal(last.role, "assistant");
    assert.match(String(last.content), /no answer/);
  });

  it("keeps the start of the history stable until it is twice the trim size", () => {
    const pair = (i: number): Message[] => [{ role: "user", content: `q${i} ${"x".repeat(1000)}` }, { role: "assistant", content: `a${i}` }];
    const small = Array.from({ length: 10 }, (_, i) => pair(i)).flat();
    assert.equal(trimHistory(small), small);
    const big = Array.from({ length: 30 }, (_, i) => pair(i)).flat();
    const trimmed = trimHistory(big);
    assert.equal(trimmed[0]!.role, "user");
    assert.ok(JSON.stringify(trimmed).length <= 12_000);
    assert.equal(trimmed.at(-1), big.at(-1));
  });

  it("removes reasoning from stored replies", () => {
    const h = [{ role: "assistant", content: "ok", reasoning_details: [{ type: "x" }] }] as unknown as Message[];
    assert.deepEqual(compactHistory(h), [{ role: "assistant", content: "ok" }]);
  });

  it("stamps user messages with weekday, local time and offset", () => {
    assert.equal(sentAt(new Date("2026-12-24T17:30:00Z"), "Europe/Berlin"), "Thu 2026-12-24 18:30 +01:00");
    assert.equal(sentAt(new Date("2026-10-06T10:00:00Z"), "UTC"), "Tue 2026-10-06 10:00 +00:00");
  });
});

describe("!undo", () => {
  it("reverts a whole request, then the one before, and closes tasks it created", async () => {
    const model = new ScriptedModel([
      toolCall("update_task", { id: 1, title: "Fix seal now", due_date: "2026-10-20T10:00:00+02:00" }, "a"),
      toolCall("create_task", { title: "Buy seal" }, "b"),
      say("Done."),
      toolCall("update_task", { id: 1, done: true }, "c"),
      say("Marked done."),
    ]);
    const { store, v, agent } = setup(model);
    v.add({ title: "Fix seal", due_date: "2026-10-12T08:00:00.000Z" });
    await agent.turn("c1", "!room", "rename and add");
    await agent.turn("c1", "!room", "done");

    assert.match((await undoLast(store, v, "!room")).message, /restored "Fix seal now" \(#1\): done/);
    assert.equal(v.tasks.get(1)!.done, false);
    const second = (await undoLast(store, v, "!room")).message;
    assert.match(second, /closed "Buy seal" \(#2\), which I had created\. Closed, not deleted/);
    assert.match(second, /restored "Fix seal" \(#1\): title, due date/);
    assert.deepEqual([v.tasks.get(1)!.title, v.tasks.get(1)!.due_date], ["Fix seal", "2026-10-12T08:00:00.000Z"]);
    assert.equal(v.tasks.get(2)!.done, true);
    assert.equal((await undoLast(store, v, "!room")).message, "Nothing to undo in this room.");
    assert.equal((await undoLast(store, v, "!other")).message, "Nothing to undo in this room.");
  });

  it("refuses when the task was changed since, or is private now, and changes nothing", async () => {
    const model = new ScriptedModel([toolCall("update_task", { id: 1, priority: 3 }), say("ok")]);
    const { store, v, agent } = setup(model);
    v.add({ title: "Fix seal" });
    await agent.turn("c1", "!room", "make it urgent");
    v.tasks.get(1)!.title = "Fix seal (edited by hand)";
    assert.match((await undoLast(store, v, "!room")).message, /#1 was changed since \(title\)/);
    assert.equal(v.tasks.get(1)!.priority, 3);
    v.tasks.get(1)!.title = "Fix seal";
    v.tasks.get(1)!.labels = [{ id: 9, title: "private" }];
    assert.match((await undoLast(store, v, "!room")).message, /#1 is private now/);
    assert.equal(v.tasks.get(1)!.priority, 3);
  });
});

describe("room snapshot", () => {
  const ROOM = { id: 2, title: "Home appliances" };

  it("gives the project's open tasks with the first message, pseudonymized, without private tasks, stored in history", async () => {
    const model = new ScriptedModel([say("You have one task (#1)."), say("ok")]);
    const { store, v, agent } = setup(model);
    v.add({ title: "Call Jana about the boiler", project_id: 2, due_date: "2026-10-12T08:00:00Z" });
    v.add({ title: "Therapy appointment", project_id: 2, labels: [{ id: 9, title: "private" }] });
    v.add({ title: "Elsewhere", project_id: 1 });
    await agent.turn("c1", "!room", "what's open?", "task", ROOM);
    const first = String(model.requests[0]!.messages.at(-1)!.content);
    assert.match(first, /what's open\?\n\n\(Context from Kesha, not from the user: open tasks of this room's project as of Tue 2026-10-06 12:00 \+02:00: #1 Call <PERSON_1> about the boiler · due 2026-10-12\)$/);
    assert.doesNotMatch(model.sent(), /Therapy|Elsewhere|Jana/);
    assert.match(JSON.stringify(store.getHistory("c1")), /Context from Kesha/);

    // Fresh and unchanged: the next message comes without a new snapshot
    await agent.turn("c1", "!room", "thanks", "task", ROOM);
    assert.doesNotMatch(String(model.requests[1]!.messages.at(-1)!.content), /Context from Kesha/);
  });

  it("refreshes the snapshot after the request changed tasks", async () => {
    const model = new ScriptedModel([toolCall("create_task", { title: "Order filter" }), say("Added (#2)."), say("ok")]);
    const { v, agent } = setup(model);
    v.add({ title: "Fix seal", project_id: 2 });
    await agent.turn("c1", "!room", "add order filter", "task", ROOM);
    await agent.turn("c1", "!room", "and now?", "task", ROOM);
    assert.match(String(model.requests[2]!.messages.at(-1)!.content), /#1 Fix seal; #2 Order filter\)$/);
  });
});

describe("0.8.1 fixes", () => {
  const ROOM = { id: 2, title: "Home appliances" };

  it("continues an !undo that Vikunja broke off halfway", async () => {
    const model = new ScriptedModel([toolCall("update_task", { id: 1, priority: 3 }, "a"), toolCall("update_task", { id: 2, priority: 4 }, "b"), say("ok")]);
    const { store, v, agent } = setup(model);
    v.add({ title: "One" });
    v.add({ title: "Two" });
    await agent.turn("c", "!room", "prioritize");
    const update = v.updateTask.bind(v);
    let calls = 0;
    v.updateTask = async (id, changes) => {
      if (++calls === 2) throw new Error("Vikunja 502");
      return update(id, changes);
    };
    const first = await undoLast(store, v, "!room");
    assert.match(first.message, /Undone so far:\n- restored "Two" \(#2\): priority\nVikunja failed while undoing #1\. Send !undo again/);
    assert.equal(first.reverted, true);
    v.updateTask = update;
    assert.match((await undoLast(store, v, "!room")).message, /^Undone:\n- restored "One" \(#1\): priority$/);
    assert.deepEqual([v.tasks.get(1)!.priority, v.tasks.get(2)!.priority], [0, 0]);
  });

  it("says when a task was created already done instead of claiming to close it", async () => {
    const model = new ScriptedModel([toolCall("create_task", { title: "Paid rent", done: true }), say("Logged.")]);
    const { store, v, agent } = setup(model);
    await agent.turn("c", "!room", "log that I paid rent");
    const r = await undoLast(store, v, "!room");
    assert.match(r.message, /"Paid rent" \(#1\) was created already done, and I can't delete tasks/);
    assert.equal(r.reverted, false);
  });

  it("tells about earlier writes when the token dies mid-request, and keeps history and snapshot right", async () => {
    const model = new ScriptedModel([toolCall("create_task", { title: "Order filter" }), toolCall("list_tasks", {}), say("never")]);
    const { store, v, agent } = setup(model);
    v.add({ title: "Fix seal", project_id: 2 });
    const listTasks = v.listTasks.bind(v);
    let lists = 0;
    // The snapshot's list works, the model's list_tasks call meets a dead token
    v.listTasks = async (q) => {
      if (++lists > 1) throw new VikunjaAuthError();
      return listTasks(q);
    };
    const res = await agent.turn("c", "!room", "add order filter and show all", "task", ROOM);
    assert.ok(res.tokenDead);
    assert.match(res.reply, /Changes I made earlier in this request were saved/);
    assert.match(JSON.stringify(store.getHistory("c")), /add order filter/);
    assert.match(store.getState("snapshot:c") ?? "", /"stale":true/);
  });

  it("after !undo the next message carries a note and a fresh snapshot", async () => {
    const model = new ScriptedModel([toolCall("update_task", { id: 1, title: "Fix seal by Friday" }), say("Renamed (#1)."), say("ok")]);
    const { store, v, agent } = setup(model);
    v.add({ title: "Fix seal", project_id: 2 });
    const key = currentConversation(store, "!room", NOW.getTime(), 3 * 3_600_000);
    await agent.turn(key, "!room", "rename it", "task", ROOM);
    const deps = {
      store, vikunja: v, timeZone: "Europe/Berlin", now: () => NOW, spentToday: () => 0, dailyCap: 1, version: "1", changelog: "",
      idleHours: 3, newConversation: () => {},
    };
    assert.match((await runCommand(deps, "!room", "!undo"))!, /restored "Fix seal" \(#1\): title/);
    await agent.turn(key, "!room", "what's the task called?", "task", ROOM);
    const sent = String(model.requests[2]!.messages.at(-1)!.content);
    assert.match(sent, /Context from Kesha, not from the user: the user sent !undo, which reverted my last changes\./);
    assert.match(sent, /open tasks of this room's project as of .*: #1 Fix seal\)$/);
    assert.equal(store.getState(`note:${key}`), undefined);
  });

  it("still gives the snapshot after a request that failed", async () => {
    const model = new ScriptedModel([
      () => {
        throw new Error("provider down");
      },
      say("ok"),
    ]);
    const { v, agent } = setup(model);
    v.add({ title: "Fix seal", project_id: 2 });
    await assert.rejects(agent.turn("c", "!room", "hi", "task", ROOM), /provider down/);
    await agent.turn("c", "!room", "hi again", "task", ROOM);
    assert.match(String(model.requests[1]!.messages.at(-1)!.content), /open tasks of this room's project as of .*: #1 Fix seal\)$/);
  });

  it("orders the snapshot by due date, undated last", () => {
    const task = (id: number, due?: string) => ({ id, title: `T${id}`, description: "", done: false, priority: 0, project_id: 2, labels: null, due_date: due ?? "0001-01-01T00:00:00Z" });
    const text = snapshotText([task(1), task(2, "2026-10-20T10:00:00Z"), task(3, "2026-10-12T10:00:00Z")], "now", "Europe/Berlin");
    assert.match(text, /: #3 T3 · due 2026-10-12; #2 T2 · due 2026-10-20; #1 T1\)$/);
  });
});

describe("letters rooms", () => {
  const LETTERS: ResearchProfile = { modelName: "test/writer", maxSteps: 3, maxTokens: 3000, maxCostPerRequest: 0.25, maxSearches: 0 };

  it("drafts with the letters model and instructions, names restored, no web search", async () => {
    const model = new ScriptedModel([
      (req) => {
        assert.equal(req.model, "test/writer");
        assert.equal(req.maxTokens, 3000);
        assert.equal(req.webSearch, undefined);
        const system = String(req.messages[0]!.content);
        assert.match(system, /drafting letters and emails/);
        assert.match(system, /Vážená paní doktorko/);
        assert.doesNotMatch(system, /Keep replies short/);
        assert.match(String(req.messages.at(-1)!.content), /<PERSON_1>/);
        return say("Předmět: Žádost o kopii zprávy\n\nVážená paní doktorko,\n\npaní <PERSON_1> mi sdělila …\n\nS pozdravem");
      },
    ]);
    const { agent } = setup(model, {}, undefined, LETTERS);
    const res = await agent.turn("c", "!room", "Napiš e-mail lékařce, Jana mi řekla, že mám požádat o kopii zprávy", "letters");
    assert.match(res.reply, /paní Jana Nováková mi sdělila/);
    assert.doesNotMatch(model.sent(), /Jana/);
  });

  it("uses the task model with the letter instructions when no letters model is set", async () => {
    const model = new ScriptedModel([(req) => (assert.equal(req.model, "test/model"), assert.match(String(req.messages[0]!.content), /drafting letters/), say("ok"))]);
    const { agent } = setup(model);
    await agent.turn("c", "!room", "draft something", "letters");
  });
});
