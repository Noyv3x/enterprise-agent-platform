import { getApiSessionGeneration } from "../lib/api";
import type { ChatMode } from "../types";
import type { AppStore } from "./loaders";

interface ScopeFence {
  mutationRevision: number;
  realtimeStatusRevision: number;
  pendingMutations: Set<number>;
  nextReadId: number;
  latestReadId: number;
}

interface SessionFence {
  store: AppStore;
  actorId: string;
  generation: number;
}

function sessionFence(store: AppStore): SessionFence {
  return {
    store,
    actorId: String(store.getState().user?.id ?? ""),
    generation: getApiSessionGeneration(),
  };
}

function sessionIsCurrent(ticket: SessionFence): boolean {
  return ticket.generation === getApiSessionGeneration()
    && ticket.actorId === String(ticket.store.getState().user?.id ?? "");
}

export interface StatusMutationTicket extends SessionFence {
  fence: ScopeFence;
  revision: number;
}

export interface StatusReadTicket extends SessionFence {
  fence: ScopeFence;
  mutationRevision: number;
  realtimeStatusRevision: number;
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
      realtimeStatusRevision: 0,
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
  return { ...sessionFence(store), fence, revision };
}

export function isStatusMutationCurrent(ticket: StatusMutationTicket): boolean {
  return sessionIsCurrent(ticket) && ticket.fence.mutationRevision === ticket.revision;
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
    ...sessionFence(store),
    fence,
    mutationRevision: fence.mutationRevision,
    realtimeStatusRevision: fence.realtimeStatusRevision,
    readId: fence.nextReadId,
    issuedDuringMutation: fence.pendingMutations.size > 0,
  };
}

/** Make every status read issued before an out-of-band realtime update stale. */
export function invalidateStatusReads(
  store: AppStore,
  mode: ChatMode,
  scopeId: string,
): void {
  const fence = scopeFence(store, mode, scopeId);
  fence.realtimeStatusRevision += 1;
}

/** Invalidate both pending mutations and every read of an unavailable scope. */
export function invalidateScopeRequests(store: AppStore, mode: ChatMode, scopeId: string): void {
  const fence = scopeFence(store, mode, scopeId);
  fence.mutationRevision += 1;
  fence.realtimeStatusRevision += 1;
  fence.latestReadId = ++fence.nextReadId;
}

/** Whether this is still the newest safe conversation read for the scope. */
export function isScopeReadCurrent(ticket: StatusReadTicket): boolean {
  return (
    sessionIsCurrent(ticket) &&
    !ticket.issuedDuringMutation &&
    ticket.fence.pendingMutations.size === 0 &&
    ticket.fence.mutationRevision === ticket.mutationRevision &&
    ticket.fence.latestReadId === ticket.readId
  );
}

export function isStatusReadCurrent(ticket: StatusReadTicket): boolean {
  return (
    isScopeReadCurrent(ticket) &&
    ticket.fence.realtimeStatusRevision === ticket.realtimeStatusRevision
  );
}
