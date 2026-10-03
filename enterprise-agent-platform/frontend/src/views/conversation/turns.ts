import type { LiveRun, Message } from "./types";
import { messageWork } from "./work";

/** History is id-ordered on the wire; a linked request belongs beside its reply, not its enqueue position. */
export function conversationTurns(messages: Message[], live: LiveRun | null) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const paired = new Set<number>();
  const requests = new Map<number, Message>();
  const inline = new Set<number>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const requestId = message.metadata.reply_to?.message_id;
    const request = requestId === undefined ? undefined : byId.get(requestId);
    if (request?.role === "user" && !paired.has(request.id)) {
      paired.add(request.id);
      requests.set(message.id, request);
    }
    for (const item of messageWork(message)?.items ?? []) {
      if (item.type === "input") inline.add(item.messageId);
    }
  }
  for (const item of live?.items ?? []) {
    if (item.type === "input") inline.add(item.messageId);
  }
  const running = messages.find((message) => message.role === "user" && message.metadata.status === "running"
    && message.metadata.inserted_into === undefined && !paired.has(message.id));
  const inserted = running ? messages.filter((message) => message.role === "user" && message.metadata.inserted_into === running.id) : [];
  for (const message of inserted) inline.add(message.id);
  const queued = messages.filter((message) => message.role === "user" && message.metadata.status === "queued"
    && !paired.has(message.id) && !inline.has(message.id));
  const queuedIds = new Set(queued.map((message) => message.id));
  const history: Message[] = [];
  for (const message of messages) {
    if (inline.has(message.id) || paired.has(message.id) || queuedIds.has(message.id) || message.id === running?.id) continue;
    const request = requests.get(message.id);
    if (request && !inline.has(request.id)) history.push(request);
    history.push(message);
  }
  return { byId, history, running, inserted, queued };
}
