import { useEffect, useSyncExternalStore } from "react";
import { request } from "../../api";
import type { ChatConversation, ChatModels } from "../conversation/types";

/** One shared list of standard-chat conversations: the sidebar's chat section and the chat view read the same state. */
interface ChatState {
  conversations: ChatConversation[] | null;
  models: ChatModels | null;
  error: string;
}

let state: ChatState = { conversations: null, models: null, error: "" };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let account: number | null = null;
let generation = 0;

/** Start a fresh cache before rendering a different authenticated account. */
export function setChatAccount(userId: number | null) {
  if (account === userId) return;
  account = userId;
  resetChatStore();
}

function set(next: Partial<ChatState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Most recently updated first, matching the server's ordering after local edits. */
function ordered(list: ChatConversation[]): ChatConversation[] {
  return [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function refreshChats(): Promise<void> {
  if (loading) return loading;
  const started = generation;
  const pending = Promise.all([
    request<{ conversations: ChatConversation[] }>("/api/chat/conversations"),
    request<ChatModels>("/api/chat/models"),
  ])
    .then(([list, models]) => {
      if (started === generation) set({ conversations: ordered(list.conversations), models, error: "" });
    })
    .catch((reason: unknown) => {
      if (started === generation) set({ error: reason instanceof Error ? reason.message : String(reason) });
    })
    .finally(() => {
      if (started === generation) loading = null;
    });
  loading = pending;
  return pending;
}

export async function createChat(input: { model_id?: string; title?: string } = {}): Promise<ChatConversation> {
  const started = generation;
  const { conversation } = await request<{ conversation: ChatConversation }>("/api/chat/conversations", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (started === generation) set({ conversations: ordered([conversation, ...(state.conversations ?? [])]) });
  return conversation;
}

export async function updateChat(id: string, patch: { title?: string; model_id?: string }): Promise<ChatConversation> {
  const started = generation;
  const { conversation } = await request<{ conversation: ChatConversation }>(`/api/chat/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (started === generation) set({ conversations: ordered((state.conversations ?? []).map((item) => (item.id === id ? conversation : item))) });
  return conversation;
}

export async function deleteChat(id: string): Promise<void> {
  const started = generation;
  await request(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (started === generation) set({ conversations: (state.conversations ?? []).filter((item) => item.id !== id) });
}

/** Bump a conversation to the top after activity without refetching the whole list. */
export function touchChat(id: string, updatedAt: string) {
  if (!state.conversations?.some((item) => item.id === id)) return;
  set({ conversations: ordered(state.conversations.map((item) => (item.id === id ? { ...item, updated_at: updatedAt } : item))) });
}

/** Subscribe and load once per cache generation, including an account switch while mounted. */
export function useChats(enabled = true): ChatState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  const currentGeneration = generation;
  useEffect(() => {
    if (enabled && state.conversations === null) void refreshChats();
  }, [enabled, currentGeneration]);
  return snapshot;
}

/** Invalidate cached data and all pending writes, including on logout or expiry. */
export function resetChatStore() {
  generation++;
  loading = null;
  set({ conversations: null, models: null, error: "" });
}
