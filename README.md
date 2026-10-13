# kesha

A Matrix bot that manages [Vikunja](https://vikunja.io) tasks through a language model on
[OpenRouter](https://openrouter.ai).

It is deliberately narrow: five strict tools, a hand-written tool loop, hard cost caps, and no personal data sent to
the model provider. Deployment, secrets and the personal dictionary live in a separate private setup, not here.
This repo holds code only.

## How it works

```
you (Element) ──E2EE──▶ Matrix ──▶ kesha ──pseudonymized──▶ OpenRouter
                                     │
                                     └──real values──▶ Vikunja API
```

- **A room is one conversation.** It starts over after `KESHA_CONVERSATION_IDLE_HOURS` of silence or on `!new`;
  each restart has its own history and placeholder numbering, and the ended one is forgotten an hour later. Messages
  of a room are handled one at a time in arrival order. A message written inside a thread is answered in that thread
  but belongs to the room's conversation. Only users in `MATRIX_ALLOWED_USERS` are answered or can invite it, and
  only in encrypted rooms.
- **Language:** Kesha answers in the language you write in, even when task titles, the room snapshot, search results
  or opened pages are in another one. Letter drafts follow the letter's language, the notes around them yours.
- **Replies are formatted:** simple Markdown from the model (bold, italic, lists, links, code) becomes Matrix HTML
  after escaping everything, only http(s) links. `(#41)` links to the task when `VIKUNJA_PUBLIC_URL` is set. The cost
  footer is small and grey.
- **Tools:** `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`. Arguments are validated
  with zod, invalid ones go back to the model as an error it can fix. There is no delete and no label tool.
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
- **Cost control:** OpenRouter's reported cost per call is logged. Per request: step limit, `max_tokens`, cost limit,
  and a warning above the alert threshold. Per day: no model calls once the cap is reached. Requests only go to
  providers that don't collect data (`data_collection: deny`, optionally zero data retention).
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
`!project [name|none]`, `!mode [letters|tasks]`, `!notify-here`, `!releases-here`, `!errors-here [off]`, `!cost`, `!cost week`. And `!research <question>` / `!r <question>`, which switch to the research model.

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
| `KESHA_PROMPT_CACHE` | `full` | Anthropic models: `full` caches system prompt and conversation, `system` only the prompt, `off` |
| `KESHA_REASONING_EFFORT` | | task model: `off`, `low`, `medium`, `high`. Unset sends nothing (Haiku 5.5 doesn't reason by default; setting it on Anthropic models turns thinking on) |
| `KESHA_RESEARCH_REASONING_EFFORT` | `medium` | same for the research model |
| `KESHA_PII_FILE` | `/config/pii.yml` | the dictionary. Kesha refuses to start without it |
| `KESHA_DATA_DIR` | `/data` | SQLite and Matrix stores |
| `KESHA_TIMEZONE` | `Europe/Berlin` | for "tomorrow" and the daily cap |
| `KESHA_CONVERSATION_IDLE_HOURS` | `3` | a room's conversation starts over after this much silence |

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
```

Test fixtures must stay fictional. Real task texts and the real dictionary never go into this repo.

## Releases

Add a `## X.Y.Z` section to `CHANGELOG.md` (what the user notices, Kesha posts it to the chat), bump `package.json`,
push a tag `vX.Y.Z`. GitHub Actions runs the tests and publishes `ghcr.io/void0walker/kesha:X.Y.Z` (public, amd64).
