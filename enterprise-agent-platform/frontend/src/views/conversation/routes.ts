/** Conversation scopes use the API route form: `private`, `channel-<id>` or `chat-<uuid>`. */
export function conversationBase(scope: string): string {
  if (scope.startsWith("chat-")) return `/api/chat/conversations/${encodeURIComponent(scope.slice(5))}`;
  return `/api/conversations/${encodeURIComponent(scope)}`;
}

export function uploadPath(scope: string): string {
  return `/api/attachments?scope=${encodeURIComponent(scope)}`;
}
