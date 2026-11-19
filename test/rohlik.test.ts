import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCommand, type CommandDeps } from "../src/commands.ts";
import { parseCallback, REDIRECT_URL, resultText, Rohlik, RohlikAuthError, withoutAnalytics } from "../src/rohlik.ts";
import { Store } from "../src/store.ts";
import { FakeVikunja } from "./fakes.ts";

const MCP = "https://mcp.example.test/mcp";
const ID = "https://identity.example.test";

/** Rohlík's identity server as its metadata describes it (2026-11-19): discovery, registration, PKCE, public client. */
function fakeIdentity() {
  const seen: { url: string; body?: string }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: MCP, authorization_servers: [ID], scopes_supported: ["openid", "email", "roles"], bearer_methods_supported: ["header"] });
    }
    if (url === `${ID}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ID, authorization_endpoint: `${ID}/oauth2/authorize`, token_endpoint: `${ID}/oauth2/token`,
        registration_endpoint: `${ID}/connect/register`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url === `${ID}/connect/register`) return json({ client_id: "kesha-client", ...JSON.parse(String(init!.body)) }, 201);
    if (url === `${ID}/oauth2/token`) {
      const params = new URLSearchParams(String(init!.body));
      if (params.get("code") !== "good-code-123") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 3600 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

function setup() {
  const store = new Store(":memory:", "Europe/Berlin");
  const identity = fakeIdentity();
  const rohlik = new Rohlik(store, { url: MCP, fetch: identity.fetchFn });
  const deps: CommandDeps = {
    store, vikunja: new FakeVikunja(), timeZone: "Europe/Berlin", now: () => new Date(), spentToday: () => 0, dailyCap: 1,
    version: "1.8.0", changelog: "", idleHours: 3, newConversation: () => {}, rohlik,
  };
  return { store, rohlik, identity, run: (body: string) => runCommand(deps, "!a", body) };
}

describe("rohlik sign-in", () => {
  it("registers once, sends a PKCE link, and takes the pasted address", async () => {
    const { rohlik, identity, run } = setup();
    assert.match((await run("!rohlik"))!, /not signed in/);
    const reply = (await run("!rohlik login"))!;
    const link = new URL(/https:\/\/identity\S+/.exec(reply)![0]);
    assert.equal(link.searchParams.get("client_id"), "kesha-client");
    assert.equal(link.searchParams.get("redirect_uri"), REDIRECT_URL);
    assert.equal(link.searchParams.get("code_challenge_method"), "S256");
    const registration = JSON.parse(identity.seen.find((s) => s.url.endsWith("/connect/register"))!.body!);
    assert.equal(registration.token_endpoint_auth_method, "none");
    assert.match((await run("!rohlik"))!, /sign-in is waiting/);

    const state = link.searchParams.get("state")!;
    assert.match((await run(`!rohlik code ${REDIRECT_URL}?code=old-code-456&state=${state}`))!, /expired or was already used/);
    assert.match((await run(`!rohlik code ${REDIRECT_URL}?code=good-code-123&state=wrong`))!, /older sign-in/);
    assert.match((await run(`!rohlik code ${REDIRECT_URL}?code=good-code-123&state=${state}`))!, /Signed in to Rohlík/);
    assert.equal(rohlik.status().signedIn, true);
    const token = new URLSearchParams(identity.seen.find((s) => s.url.endsWith("/oauth2/token"))!.body!);
    assert.ok(token.get("code_verifier"), "the token request proves the PKCE verifier");

    assert.match((await run("!rohlik logout"))!, /Signed out/);
    assert.equal(rohlik.status().signedIn, false);
    // Signing in again reuses the registration
    await run("!rohlik login");
    assert.equal(identity.seen.filter((s) => s.url.endsWith("/connect/register")).length, 1);
  });

  it("says what went wrong with a refused or garbled paste", async () => {
    const { run } = setup();
    assert.match((await run("!rohlik code what is this?"))!, /doesn't look like a sign-in code/);
    assert.match((await run("!rohlik code abcdefgh123"))!, /No Rohlík sign-in is in progress/);
    assert.match((await run(`!rohlik code ${REDIRECT_URL}?error=access_denied&error_description=User%20denied`))!, /refused the sign-in: User denied/);
  });

  it("lists and forgets remembered product choices", async () => {
    const { rohlik, run } = setup();
    assert.match((await run("!rohlik choices"))!, /don't remember any product choices/);
    rohlik.choices.remember({ item: "voda", productId: "111", product: "Magnesia Mg2+ 1,5 l", note: "6-pack" });
    assert.match((await run("!rohlik choices"))!, /- voda → Magnesia Mg2\+ 1,5 l \(6-pack\)/);
    assert.match((await run("!rohlik forget Voda"))!, /Forgot the product for "Voda"/);
    assert.match((await run("!rohlik forget voda"))!, /don't remember a product for "voda"/);
  });

  it("refuses to list tools without a sign-in", async () => {
    const { rohlik } = setup();
    await assert.rejects(rohlik.tools(), RohlikAuthError);
  });
});

describe("rohlik helpers", () => {
  it("takes the code from a whole address or alone", () => {
    assert.deepEqual(parseCallback(`${REDIRECT_URL}?code=abc123xyz&state=s1`), { code: "abc123xyz", state: "s1" });
    assert.deepEqual(parseCallback("  abc123xyz "), { code: "abc123xyz" });
  });

  it("hides Rohlík's analytics field from the model", () => {
    // As get_cart and remove_cart_item look (2026-11-19)
    const context = { type: "string", description: "one short sentence stating the user's underlying goal. Used for analytics only" };
    assert.deepEqual(withoutAnalytics({ type: "object", properties: { context }, additionalProperties: false }), { type: "object", properties: {}, additionalProperties: false });
    assert.deepEqual(withoutAnalytics({ type: "object", properties: { product_id: { type: "integer" }, context }, required: ["product_id", "context"] }),
      { type: "object", properties: { product_id: { type: "integer" } }, required: ["product_id"] });
  });

  it("joins text results and cuts long ones", () => {
    assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
    assert.equal(resultText({ content: [], structuredContent: { total: 1 } }), '{"total":1}');
    assert.match(resultText({ content: [{ type: "text", text: "x".repeat(20_000) }] }), /…\(cut, ask for fewer results\)$/);
  });
});
