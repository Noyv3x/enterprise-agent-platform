import { isApiRequestCancelled } from "../lib/api";
import type { ResourceState } from "../types";
import type { AppStore } from "./loaders";

export const IDLE_RESOURCE_STATE: ResourceState = {
  status: "idle",
  error: "",
  updatedAt: null,
};

export const resourceKeys = {
  channels: "channels",
  privateChat: "chat:private",
  channelChat: (channelId: string | number) => `chat:channel:${channelId}`,
  knowledgeList: "knowledge:list",
  knowledgeSearch: "knowledge:search",
  knowledgeDocument: (documentId: string | number) => `knowledge:document:${documentId}`,
  admin: (pageId: string) => `admin:${pageId}`,
} as const;

const requestGenerations = new WeakMap<AppStore, Map<string, number>>();

function nextGeneration(store: AppStore, key: string): number {
  let generations = requestGenerations.get(store);
  if (!generations) {
    generations = new Map();
    requestGenerations.set(store, generations);
  }
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  return generation;
}

function ownsLatestRequest(store: AppStore, key: string, generation: number): boolean {
  return (
    requestGenerations.get(store)?.get(key) === generation &&
    !!store.getState().resourceStates[key]
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || String(error) : String(error);
}

/** Track an idempotent read independently from mutation busy state.
 * Existing data remains in the store while a refresh is in flight or fails. */
export async function runResourceLoad(
  store: AppStore,
  key: string,
  load: () => Promise<void>,
): Promise<boolean> {
  if (store.getState().resourceStates[key]?.status === "loading") return false;
  const generation = nextGeneration(store, key);
  const previous = store.getState().resourceStates[key] || IDLE_RESOURCE_STATE;
  store.dispatch({
    type: "SET_RESOURCE_STATE",
    payload: { key, state: { ...previous, status: "loading", error: "" } },
  });
  try {
    await load();
    if (!ownsLatestRequest(store, key, generation)) return false;
    store.dispatch({
      type: "SET_RESOURCE_STATE",
      payload: {
        key,
        state: { status: "ready", error: "", updatedAt: Date.now() },
      },
    });
    return true;
  } catch (error) {
    // Session reset cancels outgoing reads. Never write their result into the
    // next account's freshly reset resource registry.
    if (isApiRequestCancelled(error)) return false;
    if (!ownsLatestRequest(store, key, generation)) return false;
    store.dispatch({
      type: "SET_RESOURCE_STATE",
      payload: {
        key,
        state: {
          status: "error",
          error: errorMessage(error),
          updatedAt: previous.updatedAt,
        },
      },
    });
    return false;
  }
}

export async function ensureResource(
  store: AppStore,
  key: string,
  load: () => Promise<void>,
): Promise<boolean> {
  const state = store.getState().resourceStates[key];
  if (state?.status === "ready" || state?.status === "loading") return true;
  return runResourceLoad(store, key, load);
}
