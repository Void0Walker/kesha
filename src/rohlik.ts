import { randomBytes } from "node:crypto";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { ProductChoices } from "./choices.ts";
import type { Store } from "./store.ts";
import { ToolError, type Tool } from "./tools.ts";

// Rohlík's official MCP server (https://www.rohlik.cz/stranka/rohlik-mcp-server). OAuth 2.1 with dynamic client
// registration and PKCE: the user signs in once in a browser, Kesha keeps the refresh token in SQLite. It can't place
// or pay for an order; Kesha only offers the model the cart and product tools in ROHLIK_TOOLS.

export const ROHLIK_MCP_URL = "https://mcp.rohlik.cz/mcp";

// After signing in, the browser is sent here. Nothing listens: the page fails to load, and the user pastes its address
// (with the one-time code) into the chat. The code is useless without the PKCE verifier, which never leaves Kesha
export const REDIRECT_URL = "http://localhost:8976/rohlik/callback";

// The only Rohlík tools the model sees: products and the cart. The server offers ~60 (checked 2026-11-19 with
// src/rohlik-cli.ts tools), and the sign-in allows all of them: this list is the only limit. Left out on purpose:
// checkout, delivery slots, addresses, the account, placed orders (cancel_order, remove_order_items, courier notes),
// claims and returnables, clear_cart, repeat_order, shopping lists, scheduled tasks
export const ROHLIK_TOOLS = [
  "batch_search_products",
  "get_product_details",
  "get_cart",
  "add_items_to_cart",
  "update_cart_item",
  "remove_cart_item",
];

// Every Rohlík tool takes "context": a sentence about the user's goal "for analytics". The model would fill it from the
// conversation, and arguments are restored to real names before they leave. It is removed from the schema and the call
const ANALYTICS_FIELD = "context";

/** The tool's schema without the analytics field. */
export function withoutAnalytics(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
  delete properties[ANALYTICS_FIELD];
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((r) => r !== ANALYTICS_FIELD) : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

// A tool result longer than this (characters) is cut: search results can be long and are re-sent with every call
const MAX_RESULT_CHARS = 12_000;

/** Kesha has no Rohlík login, or Rohlík rejected it (refresh token expired or revoked). */
export class RohlikAuthError extends Error {
  constructor(message = "Kesha is not signed in to Rohlík. The user has to send !rohlik login.") {
    super(message);
    this.name = "RohlikAuthError";
  }
}

const KEY = {
  client: "rohlik:client",
  tokens: "rohlik:tokens",
  verifier: "rohlik:verifier",
  state: "rohlik:state",
  discovery: "rohlik:discovery",
} as const;

/** OAuth state in Kesha's SQLite. The authorization URL is kept for the login command instead of opening a browser. */
class StoreAuthProvider implements OAuthClientProvider {
  readonly #store: Store;
  authorizationUrl: URL | undefined;

  constructor(store: Store) {
    this.#store = store;
  }

  #get<T>(key: string): T | undefined {
    const raw = this.#store.getState(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  #set(key: string, value: unknown): void {
    this.#store.setState(key, JSON.stringify(value));
  }

  get redirectUrl() {
    return REDIRECT_URL;
  }

  get clientMetadata() {
    return {
      client_name: "Kesha",
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    const state = randomBytes(16).toString("base64url");
    this.#set(KEY.state, state);
    return state;
  }

  expectedState(): string | undefined {
    return this.#get<string>(KEY.state);
  }

  clientInformation() {
    return this.#get<OAuthClientInformationMixed>(KEY.client);
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    this.#set(KEY.client, info);
  }

  tokens() {
    return this.#get<OAuthTokens>(KEY.tokens);
  }

  saveTokens(tokens: OAuthTokens) {
    this.#set(KEY.tokens, tokens);
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.#set(KEY.verifier, verifier);
  }

  codeVerifier() {
    const v = this.#get<string>(KEY.verifier);
    if (!v) throw new RohlikAuthError("No Rohlík sign-in is in progress. Send !rohlik login first.");
    return v;
  }

  discoveryState() {
    return this.#get<Parameters<NonNullable<OAuthClientProvider["saveDiscoveryState"]>>[0]>(KEY.discovery);
  }

  saveDiscoveryState(state: Parameters<NonNullable<OAuthClientProvider["saveDiscoveryState"]>>[0]) {
    this.#set(KEY.discovery, state);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const drop = (k: string) => this.#store.deleteState(k);
    if (scope === "all" || scope === "client") drop(KEY.client);
    if (scope === "all" || scope === "tokens") drop(KEY.tokens);
    if (scope === "all" || scope === "verifier") {
      drop(KEY.verifier);
      drop(KEY.state);
    }
    if (scope === "all" || scope === "discovery") drop(KEY.discovery);
  }
}

/** The code from what the user pasted: the whole address the browser ended on, or the code alone. */
export function parseCallback(input: string): { code: string; state?: string } {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const error = url.searchParams.get("error");
    if (error) throw new RohlikAuthError(`Rohlík refused the sign-in: ${url.searchParams.get("error_description") ?? error}.`);
    const code = url.searchParams.get("code");
    if (!code) throw new RohlikAuthError("That address has no code in it. Paste the whole address the browser ended on.");
    const state = url.searchParams.get("state");
    return { code, ...(state ? { state } : {}) };
  }
  if (!/^[\w.~-]{8,}$/.test(text)) throw new RohlikAuthError("That doesn't look like a sign-in code. Paste the whole address the browser ended on.");
  return { code: text };
}

/** MCP result content as text for the model: text parts joined, cut when very long. */
export function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
  const text = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n")
    || (result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "");
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(cut, ask for fewer results)` : text;
}

export interface RohlikOptions {
  url?: string;
  // Rohlík tools the model may use. Default ROHLIK_TOOLS
  allowed?: string[];
  fetch?: typeof fetch;
}

export interface RohlikStatus {
  signedIn: boolean;
  // A sign-in was started and is waiting for the pasted address
  pending: boolean;
}

/** One MCP connection to Rohlík, opened on first use and reopened after a failure. */
export class Rohlik {
  // The user's product choices, kept next to the sign-in in SQLite
  readonly choices: ProductChoices;
  readonly #provider: StoreAuthProvider;
  readonly #url: URL;
  readonly #allowed: Set<string>;
  readonly #fetch: typeof fetch | undefined;
  #client: Promise<Client> | undefined;

  constructor(store: Store, o: RohlikOptions = {}) {
    this.#provider = new StoreAuthProvider(store);
    this.choices = new ProductChoices(store.db);
    this.#url = new URL(o.url ?? ROHLIK_MCP_URL);
    this.#allowed = new Set(o.allowed ?? ROHLIK_TOOLS);
    this.#fetch = o.fetch;
  }

  status(): RohlikStatus {
    return { signedIn: this.#provider.tokens() !== undefined, pending: this.#provider.expectedState() !== undefined };
  }

  /** Starts a sign-in: the URL the user opens. Registers Kesha as an OAuth client the first time. */
  async startLogin(): Promise<URL> {
    this.#provider.invalidateCredentials("tokens");
    this.#provider.invalidateCredentials("verifier");
    this.#provider.authorizationUrl = undefined;
    await this.#close();
    const r = await auth(this.#provider, { serverUrl: this.#url, ...(this.#fetch ? { fetchFn: this.#fetch } : {}) });
    const url = this.#provider.authorizationUrl;
    if (r !== "REDIRECT" || !url) throw new RohlikAuthError("Rohlík did not ask for a sign-in.");
    return url;
  }

  /** Finishes a sign-in with what the user pasted: exchanges the code for tokens. */
  async finishLogin(pasted: string): Promise<void> {
    const { code, state } = parseCallback(pasted);
    const expected = this.#provider.expectedState();
    if (!expected) throw new RohlikAuthError("No Rohlík sign-in is in progress. Send !rohlik login first.");
    if (state !== undefined && state !== expected) throw new RohlikAuthError("That address belongs to an older sign-in. Send !rohlik login and use the new link.");
    let r: Awaited<ReturnType<typeof auth>>;
    try {
      r = await auth(this.#provider, { serverUrl: this.#url, authorizationCode: code, ...(this.#fetch ? { fetchFn: this.#fetch } : {}) });
    } catch (e) {
      // Codes last a few minutes and work once. The verifier stays, so a fresh code from the same link would still do
      if (e instanceof InvalidGrantError) {
        throw new RohlikAuthError("Rohlík didn't accept the code: it expired or was already used. Send !rohlik login and paste the address within a minute of signing in.");
      }
      throw e;
    }
    if (r !== "AUTHORIZED") throw new RohlikAuthError("Rohlík did not accept the code. Send !rohlik login and try again.");
    this.#provider.invalidateCredentials("verifier");
    await this.#close();
  }

  /** Forgets the tokens. The client registration stays, so the next sign-in skips it. */
  async logout(): Promise<void> {
    this.#provider.invalidateCredentials("tokens");
    this.#provider.invalidateCredentials("verifier");
    await this.#close();
  }

  async #close(): Promise<void> {
    const c = this.#client;
    this.#client = undefined;
    if (c) await c.then((x) => x.close()).catch(() => {});
  }

  #connect(): Promise<Client> {
    if (!this.#provider.tokens()) return Promise.reject(new RohlikAuthError());
    this.#client ??= (async () => {
      const transport = new StreamableHTTPClientTransport(this.#url, {
        authProvider: this.#provider, ...(this.#fetch ? { fetch: this.#fetch } : {}),
      });
      const client = new Client({ name: "kesha", version: "1" });
      await client.connect(transport);
      return client;
    })();
    this.#client.catch(() => (this.#client = undefined));
    return this.#client;
  }

  /** Runs fn with the connection. An auth failure means the login is gone; anything else reconnects once. */
  async #with<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(await this.#connect());
      } catch (e) {
        await this.#close();
        if (e instanceof RohlikAuthError) throw e;
        if (e instanceof UnauthorizedError) {
          this.#provider.invalidateCredentials("tokens");
          throw new RohlikAuthError("Rohlík no longer accepts Kesha's sign-in. The user has to send !rohlik login.");
        }
        if (attempt >= 1) throw e;
      }
    }
  }

  /** All tools the server offers, with their schemas. For checking the allowlist. */
  async listAllTools() {
    return this.#with(async (c) => (await c.listTools()).tools);
  }

  /** The allowed Rohlík tools as Kesha tools. Arguments are checked by the server; its errors go to the model. */
  async tools(): Promise<Tool[]> {
    const listed = await this.listAllTools();
    const missing = [...this.#allowed].filter((n) => !listed.some((t) => t.name === n));
    if (missing.length) console.warn(`rohlik: allowed tools not offered by the server: ${missing.join(", ")}`);
    return listed
      .filter((t) => this.#allowed.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t): Tool => ({
        name: t.name,
        description: t.description ?? t.name,
        schema: z.record(z.string(), z.unknown()),
        parameters: withoutAnalytics(t.inputSchema as Record<string, unknown>),
        run: async (args) => {
          const { [ANALYTICS_FIELD]: _analytics, ...sent } = args as Record<string, unknown>;
          try {
            const r = await this.#with((c) => c.callTool({ name: t.name, arguments: sent }));
            const text = resultText(r as { content?: unknown; structuredContent?: unknown });
            if (r.isError) throw new ToolError(`Rohlík: ${text || "the tool failed"}`);
            return text;
          } catch (e) {
            if (e instanceof ToolError) throw e;
            if (e instanceof RohlikAuthError) throw new ToolError(e.message);
            throw new ToolError(`Rohlík did not answer (${e instanceof Error ? e.message : String(e)}). Tell the user the cart may not have changed.`);
          }
        },
      }));
  }
}
