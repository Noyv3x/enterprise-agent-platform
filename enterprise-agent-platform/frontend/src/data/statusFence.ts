import type { ChatMode } from "../types";
import type { AppStore } from "./loaders";

interface ScopeFence {
  mutationRevision: number;
  pendingMutations: Set<number>;
  nextReadId: number;
  latestReadId: number;
}

export interface StatusMutationTicket {
  fence: ScopeFence;
  revision: number;
}

export interface StatusReadTicket {
  fence: ScopeFence;
  mutationRevision: number;
  readId: number;
  issuedDuringMutation: boolean;
}

const fences = new WeakMap<AppStore, Map<string, ScopeFence>>();

function scopeKey(store: AppStore, mode: ChatMode, scopeId: string): string {
  const owner = String(store.getState().user?.id ?? "anonymous");
  return `${owner}:${mode}:${String(scopeId)}`;
}

function scopeFence(store: AppStore, mode: ChatMode, scopeId: string): ScopeFence {
  let storeFences = fences.get(store);
  if (!storeFences) {
    storeFences = new Map();
    fences.set(store, storeFences);
  }
  const key = scopeKey(store, mode, scopeId);
  let fence = storeFences.get(key);
  if (!fence) {
    fence = {
      mutationRevision: 0,
      pendingMutations: new Set(),
      nextReadId: 0,
      latestReadId: 0,
    };
    storeFences.set(key, fence);
  }
  return fence;
}

export function beginStatusMutation(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
): StatusMutationTicket {
  const fence = scopeFence(store, mode, scopeId);
  fence.mutationRevision += 1;
  const revision = fence.mutationRevision;
  fence.pendingMutations.add(revision);
  return { fence, revision };
}

export function isStatusMutationCurrent(ticket: StatusMutationTicket): boolean {
  return ticket.fence.mutationRevision === ticket.revision;
}

export function finishStatusMutation(ticket: StatusMutationTicket): void {
  ticket.fence.pendingMutations.delete(ticket.revision);
}

export function issueStatusRead(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
): StatusReadTicket {
  const fence = scopeFence(store, mode, scopeId);
  fence.nextReadId += 1;
  fence.latestReadId = fence.nextReadId;
  return {
    fence,
    mutationRevision: fence.mutationRevision,
    readId: fence.nextReadId,
    issuedDuringMutation: fence.pendingMutations.size > 0,
  };
}

export function isStatusReadCurrent(ticket: StatusReadTicket): boolean {
  return (
    !ticket.issuedDuringMutation &&
    ticket.fence.pendingMutations.size === 0 &&
    ticket.fence.mutationRevision === ticket.mutationRevision &&
    ticket.fence.latestReadId === ticket.readId
  );
}
