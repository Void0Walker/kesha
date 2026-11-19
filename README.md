# kesha

A Matrix bot that manages [Vikunja](https://vikunja.io) tasks through a language model on
[OpenRouter](https://openrouter.ai).

It is deliberately narrow: five strict task tools (plus an allowlist of Rohlík cart tools when shopping), a
hand-written tool loop, hard cost caps, and no personal data sent to the model provider. Deployment, secrets and the
personal dictionary live in a separate private setup, not here. This repo holds code only.

## How it works

```
you (Element) ──E2EE──▶ Matrix ──▶ kesha ──pseudonymized──▶ OpenRouter
                                     │
                                     ├──real values──▶ Vikunja API
                                     └──real values──▶ Rohlík MCP (search and cart, with !shop)
```

- **A room is one conversation.** It starts over after `KESHA_CONVERSATION_IDLE_HOURS` of silence or on `!new`;
  each restart has its own history and placeholder numbering, and the ended one is forgotten an hour later. Messages
  of a room are handled one at a time in arrival order. A message written inside a thread is answered in that thread
  but belongs to the room's conversation. Only users in `MATRIX_ALLOWED_USERS` are answered or can invite it, and
  only in encrypted rooms.
- **Language:** Kesha answers in the language you write in, even when task titles, the room snapshot, search results
  or opened pages are in another one. Letter drafts follow the letter's language, the notes around them yours.
- **Voice messages** are transcribed by the Whistle service in the tools repo (`KESHA_TRANSCRIBE_URL`, English only,
  no Czech) and then handled like typed text, with the transcript shown at the top of the reply. "command <name> ..."
  spoken is `!<name> ...` typed. Audio is decrypted in memory and never stored; the transcript goes through the same
  pseudonymization as any message. The original voice message stays in the room.
- **Replies are formatted:** simple Markdown from the model (bold, italic, lists, links, code) becomes Matrix HTML
  after escaping everything, only http(s) links. `(#41)` links to the task when `VIKUNJA_PUBLIC_URL` is set. The cost
  footer is small and grey.
- **Tools:** `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`. Arguments are validated
  with zod, invalid ones go back to the model as an error it can fix. There is no delete and no label tool.
  A due date without a time means noon of that day in `KESHA_TIMEZONE`. Marking a repeating task done is reported as
  Vikunja handles it: the occurrence is done and the task comes back with the next date.
- **Writes are verified in code:** after every create or update the task is read back and compared.
  Vikunja's update replaces the whole task, so updates read, merge and send the full task.
- **Private tasks:** tasks labelled `private` are hidden from lists and refused by `get_task`/`update_task`.
  They never reach the model.
- **Pseudonymization** at the OpenRouter boundary, both directions:
  - names, places, organisations from a YAML dictionary (with inflected forms), plus regexes for emails, phone
    numbers, IBANs, card numbers, IPs, URLs with tokens and Czech/Slovak birth numbers (`YYMMDD/XXXX`), become
    placeholders like `<PERSON_1>`;
  - placeholders are numbered per conversation and stored in SQLite, so the same person can't be linked across
    conversations. Mappings and history of an ended conversation are deleted an hour later, of any conversation after
    30 idle days;
  - tool arguments are restored before Vikunja sees them, an invented placeholder is rejected;
  - OpenRouter's "Sensitive Info" guardrail redacts one way (`[PERSON_NAME]`, `[ADDRESS]`, ...), nothing can restore
    it. Tool arguments carrying those labels are refused, so they never land in Vikunja. If you use that guardrail, turn
    off its Person name and Address detection: the dictionary handles names reversibly, and the NLP detection also
    hits words that aren't names;
  - everything that was sent is logged (pseudonymized) in SQLite for reviewing leaks.
- **Cost control:** OpenRouter's reported cost per call is logged; with your own provider key on OpenRouter (BYOK, e.g.
  Anthropic credits) the provider's price (`upstream_inference_cost`) is added to OpenRouter's fee. Per request: step
  limit, `max_tokens`, cost limit, and a warning above the alert threshold. Per day: no model calls once the cap is
  reached. Requests only go to providers that don't collect data (`data_collection: deny`, optionally zero data
  retention). With your own provider key on OpenRouter (BYOK) and its default ZDR declaration, OpenRouter still treats
  the endpoint as ZDR, but the provider keeps requests under your own account's policy (Anthropic: 30 days unless you
  have a ZDR agreement).
- **Vikunja token:** checked on start (exit 1 if it fails). 7 days before `VIKUNJA_TOKEN_EXPIRES` Kesha creates a
  "Rotate Kesha's Vikunja token" task in the inbox, due 3 days before expiry, and says so in Matrix.
  If Vikunja rejects the token later, Kesha stops using it and tells you.

- **Research:** `!research <question>` or `!r <question>` switches the conversation to `KESHA_RESEARCH_MODEL` with
  web search and page fetching (Exa through OpenRouter's `openrouter:web_search` and `openrouter:web_fetch`, the
  engine that works with ZDR enforced) and the same task tools, so findings can go straight into a task. Follow-ups
  stay with the research model until it records a task or decision (any create or update), then the room's own model
  takes over again; `!new` and the idle restart end it too. Each research message shows a "Researching…" notice that
  is edited with the result. Searches are capped per request and opened pages per model call (each cut to ~6k tokens),
  sources are listed under the reply. The model is told to open or find in search results every product or shop it
  links, and to say what it couldn't verify (big shops often block automated visitors; Exa's crawl gets through more
  often than a direct fetch). Search queries and URLs come from the pseudonymized conversation, so placeholders never
  reach the search engine as real names. Exa has its own retention policy, ZDR doesn't cover it.
- **Cost in every reply:** each answer ends with what the request cost, the number of web searches, and today's total
  against the daily cap, e.g. `— $0.0251 · 2 searches · 1 page opened · today $0.1520 of $1.00`. OpenRouter's
  reported cost sometimes leaves the search fees out, so Kesha adds `KESHA_SEARCH_COST` per search (and $0.001 per
  opened page, when OpenRouter reports them) when it does.

- **Shopping:** `!shop` (or `!shop no meat this week`) reads the open tasks of the Vikunja project
  `KESHA_SHOPPING_PROJECT` (default `Daily`, private tasks left out) and has `KESHA_SHOPPING_MODEL` fill the cart at
  Rohlík.cz through [Rohlík's MCP server](https://www.rohlik.cz/stranka/rohlik-mcp-server). The project may hold other
  tasks: the model takes only things to buy and names the ones it skipped. It checks the cart first, adds one product
  per item, asks instead of guessing when the choice is a matter of taste, and replies with what it added and the
  total. Follow-ups ("swap the milk for oat milk", "mark what you added as done") stay with the shopping model until
  `!new` or the idle restart; `!r` switches to research. Tasks are only changed when you ask.
  - **Remembered choices:** when you pick one of the offered products, name one ("water is always Magnesia") or
    correct a choice, the model records it (`remember_product_choice`) under the item as you write it. Every `!shop`
    carries these choices, and the model adds them by product id without searching, so a familiar list costs fewer
    calls. It searches again only if the product is gone. Its own guesses are never recorded. `!rohlik choices` lists
    them, `!rohlik forget <item>` drops one. They are kept in SQLite (`product_choices`) until forgotten.
  - **Only the cart:** the model gets the Rohlík tools in `KESHA_ROHLIK_TOOLS` (default: search, product details, cart,
    add, change quantity, remove; see `ROHLIK_TOOLS` in `src/rohlik.ts`). Delivery slots, addresses, the account,
    placed orders, emptying the cart and repeating orders stay out. Rohlík's server can't place or pay for an order at
    all: you check the cart and order in Rohlík. Cart changes aren't covered by `!undo`.
  - **Sign-in:** `!rohlik login` registers Kesha with Rohlík's identity server (OAuth 2.1, dynamic client registration,
    PKCE) and posts a link. Rohlík warns that Kesha is an unverified app, which is how every self-registered MCP
    client is shown. After signing in, the browser lands on a `http://localhost:8976/...` address that doesn't load:
    send it as `!rohlik code <address>`. The code is single-use and worthless without the PKCE verifier, which stays
    in Kesha. The tokens are kept in SQLite on the data volume and refreshed automatically; `!rohlik logout` forgets
    them. The token itself allows every tool of Rohlík's server: the allowlist is enforced by Kesha.
  - **Privacy:** search queries and cart changes go to Rohlík with real values (tool arguments are restored like for
    Vikunja); Rohlík's answers are pseudonymized before the model sees them, like task results. Every Rohlík tool asks
    for a `context` sentence about the user's goal "for analytics": Kesha removes it from the schema and the call, so
    nothing from the conversation reaches Rohlík beyond the search words and product ids. Search results put sponsored
    products first; the model is told to choose by match, preferring the user's Rohlík favourites. Results over 12k
    characters are cut. To check the allowlist against what Rohlík offers: `node src/rohlik-cli.ts login`, `code`,
    `tools` with a local `KESHA_DATA_DIR`.
  - **Cost:** a full list is 20–40 model calls, so shopping has its own caps (`KESHA_SHOPPING_*`, $1 per request by
    default). With `KESHA_SHOPPING_DAILY_COST_CAP` set, shopping also has its own daily budget and no longer counts
    against `KESHA_DAILY_COST_CAP` (the reply footer then says `shopping today`, `!cost today` shows both); unset, it
    shares the main one.
  - **Languages:** list items may be in Russian or any other language; the model translates them for Rohlík's Czech
    catalogue and matches remembered choices by meaning. Names in Cyrillic are only pseudonymized if the dictionary
    lists their Cyrillic spellings.

- **Release notes:** when a new version starts, Kesha posts its section of `CHANGELOG.md` to the room you last wrote
  in, once per version.

- **Rooms:** Kesha works in every encrypted room it's invited to. `!project <name>` gives a room a default project:
  new tasks there go to it (enforced in code when the model names no project), and the model treats questions there
  as being about it. The title reaches the model pseudonymized.
- **Decisions:** only on request ("note that decision"), Kesha creates an open task titled "Decision: …", with a
  summary (what, why, what was ruled out, date) in the room's project. Conversations themselves
  never go to Vikunja; they stay pseudonymized in Kesha's SQLite and are deleted after 30 idle days.
- **Shortcuts without the model:** `!today`, `!week`, `!open` list the room's project (or all projects) straight
  from Vikunja, private tasks left out, overdue first.
- **Undo:** the write tools record each change (fields before and after) per request. `!undo` reverts the room's
  latest request as a whole, then the one before. It checks everything first and refuses if a task changed in
  Vikunja since or became private; created tasks are closed (Kesha can't delete). Each change is marked undone right
  after its write, so an undo that Vikunja broke off continues with the next `!undo`. The conversation gets a note
  about the undo and a fresh snapshot with the next message. The log holds real task text and
  is pruned after 7 days.
- **Room snapshot:** in a room with a project, the first message of a conversation carries the project's open tasks
  (the 30 due soonest, pseudonymized, private ones left out), and again after a change or 30 minutes. It's stored in the
  history like the message, so the cached prefix stays stable.
- **Letter rooms:** `!mode letters` gives a room instructions for drafting letters and emails (formal Czech by default:
  subject line, greeting by title rather than name, since placeholders come back in the nominative and Czech greetings
  need the vocative, gaps marked `[doplnit: …]`) and `KESHA_LETTERS_MODEL`. Task tools stay available. Switching the
  mode starts a new conversation.
- **Notifications:** reminders and warnings go to the room set with `!notify-here`, release notes to the one set with
  `!releases-here`, otherwise to the room the user last wrote in.
- **Error reports:** only after `!errors-here`: failed requests and commands, model timeouts, housekeeping errors and
  crashes go to that room with the error, its cause and the first stack frames (a crash is kept in SQLite and reported
  by the next start). The same failure is sent at most once per 15 minutes, then with a count of the repeats.
  `!errors-here off` stops them; without it errors only go to `docker logs`.
- **Model calls are streamed:** a call fails only when OpenRouter sends nothing for 2 minutes or the call passes 5
  minutes, so research with searches, opened pages and reasoning isn't cut off for being slow. Only the wait for the
  first response is retried once: a call that already streams is never sent again, since its searches would run (and
  be paid) twice. When Kesha drops a stream, OpenRouter cancels the call upstream.

- **Token economy:** the system prompt and tool schemas are identical in every call (the send time goes on each user
  message instead), so Anthropic models read them from the prompt cache at a tenth of the price, and OpenRouter keeps a
  conversation on the same provider (`session_id`, a hash that can't be linked to Matrix ids). After each request only
  the user messages and final replies are kept: tool calls and results aren't re-sent with every later message. Task
  results leave out default fields. History over 24k characters is cut to ~12k at once, so its start stays cacheable.
  Request bodies in the call log are blanked after 30 days, costs stay.

Commands in a chat, answered without the model and free: `!help`, `!today`, `!week`, `!open`, `!undo`, `!new`,
`!project [name|none]`, `!mode [letters|tasks]`, `!notify-here`, `!releases-here`, `!errors-here [off]`, `!cost` (this month), `!cost week`, `!cost today`, `!rohlik [login|code <address>|choices|forget <item>|logout]`. And `!research <question>` / `!r <question>`, which switch to the research model, and `!shop [notes]`, which switches to the shopping model.

## Configuration

Environment variables:

| Variable | Default | |
|---|---|---|
| `MATRIX_HOMESERVER_URL` | | e.g. `https://matrix.example.org` |
| `MATRIX_ACCESS_TOKEN` | | the bot account's token. A new token means a new device: empty the `matrix-crypto` folder in the data dir |
| `MATRIX_ALLOWED_USERS` | | comma-separated, e.g. `@you:example.org` |
| `VIKUNJA_URL` | | e.g. `https://tasks.example.org` |
| `VIKUNJA_TOKEN` | | API token: tasks read/create/update, projects read |
| `VIKUNJA_TOKEN_EXPIRES` | | `YYYY-MM-DD`, drives the rotation reminder |
| `VIKUNJA_INBOX_PROJECT_ID` | | default project for new tasks and the reminder |
| `VIKUNJA_PUBLIC_URL` | | Vikunja as you open it, e.g. `https://tasks.example.org`, for task links in replies |
| `OPENROUTER_API_KEY` | | |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | |
| `OPENROUTER_ZDR` | `true` | only zero-data-retention endpoints |
| `KESHA_MODEL` | | OpenRouter model id |
| `KESHA_MAX_STEPS` | `8` | model calls per request |
| `KESHA_MAX_TOKENS` | `1500` | per model call |
| `KESHA_MAX_COST_PER_REQUEST` | `0.25` | credits (USD) |
| `KESHA_ALERT_COST` | `0.10` | warn when a request costs more |
| `KESHA_DAILY_COST_CAP` | `1` | shared by task and research requests |
| `KESHA_RESEARCH_MODEL` | | OpenRouter model id for `!research`, needs a ZDR endpoint. Unset: research is off |
| `KESHA_RESEARCH_MAX_STEPS` | `6` | model calls per research request |
| `KESHA_RESEARCH_MAX_TOKENS` | `3000` | per model call |
| `KESHA_RESEARCH_MAX_COST_PER_REQUEST` | `0.25` | credits (USD), search fees included |
| `KESHA_RESEARCH_MAX_SEARCHES` | `6` | web searches per research request |
| `KESHA_RESEARCH_MAX_FETCHES` | `5` | web pages opened per research model call (Exa, $0.001 each), `0` turns it off |
| `KESHA_SEARCH_COST` | `0.007` | Exa's price per search, for the cost accounting |
| `KESHA_LETTERS_MODEL` | `KESHA_MODEL` | model for rooms set with `!mode letters`, needs a ZDR endpoint |
| `KESHA_LETTERS_MAX_STEPS` | `4` | model calls per request in letter rooms |
| `KESHA_LETTERS_MAX_TOKENS` | `3000` | per model call |
| `KESHA_LETTERS_MAX_COST_PER_REQUEST` | `0.25` | credits (USD) |
| `KESHA_LETTERS_REASONING_EFFORT` | | like `KESHA_REASONING_EFFORT` |
| `KESHA_SHOPPING_MODEL` | | OpenRouter model id for `!shop`, needs a ZDR endpoint, e.g. `anthropic/claude-sonnet-5.5`. Unset: shopping is off |
| `KESHA_SHOPPING_PROJECT` | `Daily` | Vikunja project with the shopping list, by title (exact, else the only one containing it) |
| `KESHA_SHOPPING_MAX_STEPS` | `30` | model calls per shopping request |
| `KESHA_SHOPPING_MAX_TOKENS` | `3000` | per model call |
| `KESHA_SHOPPING_MAX_COST_PER_REQUEST` | `1` | credits (USD) |
| `KESHA_SHOPPING_DAILY_COST_CAP` | | shopping's own daily budget, apart from `KESHA_DAILY_COST_CAP`. Unset: shared |
| `KESHA_SHOPPING_REASONING_EFFORT` | `low` | like `KESHA_REASONING_EFFORT`. Use `low` rather than `off` on Sonnet/Opus 5.5, which can't turn thinking off |
| `KESHA_ROHLIK_TOOLS` | see `src/rohlik.ts` | comma-separated Rohlík tools the model may use |
| `KESHA_ROHLIK_MCP_URL` | `https://mcp.rohlik.cz/mcp` | Rohlík's MCP server |
| `KESHA_PROMPT_CACHE` | `full` | Anthropic models: `full` caches system prompt and conversation, `system` only the prompt, `off` |
| `KESHA_REASONING_EFFORT` | | task model: `off`, `low`, `medium`, `high`. Unset sends nothing (Haiku 5.5 doesn't reason by default; setting it on Anthropic models turns thinking on) |
| `KESHA_RESEARCH_REASONING_EFFORT` | `medium` | same for the research model |
| `KESHA_PII_FILE` | `/config/pii.yml` | the dictionary. Kesha refuses to start without it |
| `KESHA_DATA_DIR` | `/data` | SQLite and Matrix stores |
| `KESHA_TIMEZONE` | `Europe/Berlin` | for "tomorrow", dates given without a time, and the daily cap |
| `KESHA_CONVERSATION_IDLE_HOURS` | `3` | a room's conversation starts over after this much silence |
| `KESHA_TRANSCRIBE_URL` | | the Whistle transcription service, e.g. `http://whistle:8080`. Unset: voice messages get a note that there is none |

Dictionary format:

```yaml
people:
  - names: [Jana Nováková, Jana, Nováková]   # first entry is what comes back
    forms: [Jany, Janě, Janou, Novákové, Novákovou]
places:
  - names: [Vinohradská 12, Vinohradská]
orgs:
  - names: [Acme s.r.o., Acme]
other:
  - names: [example.com]
```

Every listed name and form is matched as a whole word, case-insensitively, and maps to one placeholder.

## Development

Node 24, TypeScript run directly through Node's type stripping, no build step.

```
npm ci
npm test            # node:test, fictional data only
npm run typecheck
npm run lint        # oxlint
```

Test fixtures must stay fictional. Real task texts and the real dictionary never go into this repo.

## Releases

Add a `## X.Y.Z` section to `CHANGELOG.md` (what the user notices, Kesha posts it to the chat), bump `package.json`,
push a tag `vX.Y.Z`. GitHub Actions runs the tests and publishes `ghcr.io/void0walker/kesha:X.Y.Z` (public, amd64).
