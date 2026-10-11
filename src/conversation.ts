import type { Store } from "./store.ts";

// A room is one ongoing conversation. It starts over after a quiet period or on !new; each restart is a new key,
// with its own history and placeholder numbering. The key is only used locally (SQLite), never sent anywhere.

interface ConversationState {
  epoch: number;
  // Matrix timestamp of the last message, from the server, so restarts and queued messages don't shift it
  lastMsgTs: number;
}

const stateKey = (room: string) => `conv:${room}`;
const conversationKey = (room: string, epoch: number) => `${room}#${epoch}`;

/** The conversation a message at msgTs belongs to. Call once per message, in arrival order. */
export function currentConversation(store: Store, room: string, msgTs: number, idleMs: number, forceNew = false): string {
  const raw = store.getState(stateKey(room));
  const prev = raw ? (JSON.parse(raw) as ConversationState) : undefined;
  const fresh = !prev || forceNew || msgTs - prev.lastMsgTs > idleMs;
  const next: ConversationState = { epoch: fresh ? (prev?.epoch ?? 0) + 1 : prev.epoch, lastMsgTs: Math.max(msgTs, prev?.lastMsgTs ?? 0) };
  store.setState(stateKey(room), JSON.stringify(next));
  return conversationKey(room, next.epoch);
}

/** Keys of the conversations still going on, one per room. Everything else has ended and can be forgotten early. */
export function activeConversations(store: Store): Set<string> {
  const rows = store.db.prepare("SELECT key, value FROM state WHERE key LIKE 'conv:%'").all() as { key: string; value: string }[];
  return new Set(rows.map((r) => conversationKey(r.key.slice("conv:".length), (JSON.parse(r.value) as ConversationState).epoch)));
}

/** The room's current conversation, without counting this as a message. Undefined before the first message. */
export function peekConversation(store: Store, room: string): string | undefined {
  const raw = store.getState(stateKey(room));
  return raw ? conversationKey(room, (JSON.parse(raw) as ConversationState).epoch) : undefined;
}
