# Changelog

Kesha posts the section of a new version to the chat once it runs. Keep entries short and written for the user.

## 1.2.0

- I answer in the language you write in, even when your tasks or the pages I read are in another one.
- `!r` now keeps researching: follow-up questions stay with the research model and web search, until I record a task or a decision for you. Then I'm back to the quick model. `!new` also ends it.
- Research can open web pages, not only search. I check products and shops before I link them, and tell you what I couldn't verify (Amazon and other big shops often block bots). The cost line shows how many pages I opened.

## 1.1.0

- Letter rooms: `!mode letters` turns a room into a writing desk for emails and letters to officials, doctors and other important people, in formal Czech unless you ask otherwise. Describe what you need, refine the draft ("more polite", "add the case number"), `!new` before the next letter. Drafts use a stronger model and cost about a cent. `!mode tasks` switches back.
- Czech birth numbers (rodné číslo, like 855612/1234) are now replaced before anything reaches the model, like emails and phone numbers.

## 1.0.0

First stable release. What I can do:

- Your Vikunja tasks from Matrix in plain language: find, add, change, finish, move, note decisions. Each room is one conversation; `!project <name>` ties a room to a project.
- `!today`, `!week`, `!open` list tasks instantly and free; `!undo` takes back my last changes.
- `!r <question>` researches with web search and lists sources.
- Privacy: names and details from your dictionary and personal data like emails and phone numbers are replaced before anything reaches the model; tasks labelled private never do. Only providers that keep no data are used.
- Costs: every reply shows what it cost; daily cap, per-request caps, `!cost` and `!cost week`; cached prompts keep most messages at a fraction of a cent.
- `!help` lists all commands.

## 0.8.1

- `!undo` can be continued if Vikunja fails halfway: send it again. After an undo I know the change was taken back.
- A task created already done can't be undone by closing it; I now say so instead of claiming I closed it.
- If my Vikunja token dies in the middle of a request, I tell you about changes I had already made instead of "nothing was changed".
- `!week` and `!cost week` count calendar days correctly around clock changes. Long task lists say when they may be incomplete.
- The tasks I know in a project room are the ones due soonest.

## 0.8.0

- `!today`, `!week` and `!open` list what's due today, this week, or everything open, for this room's project (or all projects). Instant and free, no model involved.
- `!undo` takes back my last change in this room: everything that one message changed. Again for the one before. I won't undo if you edited the task in Vikunja since. Tasks I created get closed, not deleted.
- `!cost week` shows the last 7 days, this room's share, and how much came from the cache.
- In a room with a project I already know its open tasks when you write, so most questions need fewer steps.

## 0.7.0

- Each room is now one ongoing conversation: just write, no need to reply inside threads. After 3 hours of silence I start fresh, or right away with `!new`.
- `!r <question>` (or `!research`) answers that one message with web search; the next message is a normal one again. I post "Researching…" and update it when I'm done.
- Replies are formatted: bold, lists and links, `(#41)` opens the task in Vikunja, and the cost line is small and grey.
- The typing indicator stays on while I work on longer requests.

## 0.6.0

- Cheaper replies: my instructions and tools are now cached between messages (about a tenth of the price from the second message on), and I no longer re-send old task lists with every message. A longer conversation used about 70% fewer tokens in tests.
- When I mention a task I add its number, like (#41), so you can refer to it later.

## 0.5.1

- A noted decision stays an open task, since it usually still needs doing. Mark it done in Vikunja once it's acted on.

## 0.5.0

- Say "note that decision" (or similar) and I record it as a finished task in the room's project: "Decision: …", with what was decided, why, what was ruled out, and the date. A summary, never the conversation itself.
- I only create or change tasks when you ask. Talking about something doesn't add a task.

## 0.4.0

- Rooms with a topic: `!project <name>` in a room makes new tasks there go to that project, and questions there are about it. `!project` shows it, `!project none` removes it.
- `!releases-here`: release notes go to this room. `!notify-here`: reminders and warnings go to this room. Both otherwise go to the room you last wrote in.
- `!help` lists all commands. It costs nothing, the model isn't involved.

## 0.3.0

- I announce each new version here, with what changed.

## 0.2.1

- Text that OpenRouter's guardrail hid before I saw it ([PERSON_NAME] and similar) never goes into your tasks. I tell you what I couldn't see instead.

## 0.2.0

- `!research <question>` starts a research thread: a stronger model with web search, sources under the answer. Follow-ups in that thread stay in research mode.
- Every reply ends with what it cost, the number of web searches, and today's total against the daily cap.

## 0.1.0

- First release: your Vikunja tasks from Matrix, names pseudonymized before they reach the model, cost caps, token rotation reminder.
