# Changelog

Kesha posts the section of a new version to the chat once it runs. Keep entries short and written for the user.

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
