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

- **One Matrix thread is one conversation.** A top-level message starts a thread, Kesha answers inside it.
  Only users in `MATRIX_ALLOWED_USERS` are answered or can invite it, and only in encrypted rooms.
- **Tools:** `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`. Arguments are validated
  with zod, invalid ones go back to the model as an error it can fix. There is no delete and no label tool.
- **Writes are verified in code:** after every create or update the task is read back and compared.
  Vikunja's update replaces the whole task, so updates read, merge and send the full task.
- **Private tasks:** tasks labelled `private` are hidden from lists and refused by `get_task`/`update_task`.
  They never reach the model.
- **Pseudonymization** at the OpenRouter boundary, both directions:
  - names, places, organisations from a YAML dictionary (with inflected forms), plus regexes for emails, phone
    numbers, IBANs, card numbers, IPs and URLs with tokens, become placeholders like `<PERSON_1>`;
  - placeholders are numbered per thread and stored in SQLite, so the same person can't be linked across threads.
    Mappings and history are deleted after 30 idle days;
  - tool arguments are restored before Vikunja sees them, an invented placeholder is rejected;
  - everything that was sent is logged (pseudonymized) in SQLite for reviewing leaks.
- **Cost control:** OpenRouter's reported cost per call is logged. Per request: step limit, `max_tokens`, cost limit,
  and a warning above the alert threshold. Per day: no model calls once the cap is reached. Requests only go to
  providers that don't collect data (`data_collection: deny`, optionally zero data retention).
- **Vikunja token:** checked on start (exit 1 if it fails). 7 days before `VIKUNJA_TOKEN_EXPIRES` Kesha creates a
  "Rotate Kesha's Vikunja token" task in the inbox, due 3 days before expiry, and says so in Matrix.
  If Vikunja rejects the token later, Kesha stops using it and tells you.

Commands in a chat: `!cost` shows today's spend.

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
| `OPENROUTER_API_KEY` | | |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | |
| `OPENROUTER_ZDR` | `true` | only zero-data-retention endpoints |
| `KESHA_MODEL` | | OpenRouter model id |
| `KESHA_MAX_STEPS` | `8` | model calls per request |
| `KESHA_MAX_TOKENS` | `1500` | per model call |
| `KESHA_MAX_COST_PER_REQUEST` | `0.25` | credits (USD) |
| `KESHA_ALERT_COST` | `0.10` | warn when a request costs more |
| `KESHA_DAILY_COST_CAP` | `1` | |
| `KESHA_PII_FILE` | `/config/pii.yml` | the dictionary. Kesha refuses to start without it |
| `KESHA_DATA_DIR` | `/data` | SQLite and Matrix stores |
| `KESHA_TIMEZONE` | `Europe/Berlin` | for "tomorrow" and the daily cap |

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

Push a tag `vX.Y.Z`. GitHub Actions runs the tests and publishes `ghcr.io/void0walker/kesha:X.Y.Z` (public, amd64).
