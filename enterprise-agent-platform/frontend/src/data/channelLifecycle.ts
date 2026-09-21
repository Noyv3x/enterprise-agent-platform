import { getApiSessionGeneration } from "../lib/api";
import { hasPermission } from "../store/selectors";
import type { Channel, Id } from "../types";
import { removeCachedChat } from "./chatCache";
import { navigateToView, selectChannel } from "./chatActions";
import type { AppStore } from "./loaders";
import { invalidateScopeRequests } from "./statusFence";

interface ChannelAvailability {
  actorId: string;
  generation: number;
  unavailable: Set<string>;
}

const availability = new WeakMap<AppStore, ChannelAvailability>();

function forSession(store: AppStore): ChannelAvailability {
  const actorId = String(store.getState().user?.id ?? "");
  const generation = getApiSessionGeneration();
  let current = availability.get(store);
  if (!current || current.actorId !== actorId || current.generation !== generation) {
    current = { actorId, generation, unavailable: new Set() };
    availability.set(store, current);
  }
  return current;
}

/** Unavailable IDs cannot be restored by delayed lists, sends, or realtime events. */
export function isChannelUnavailable(store: AppStore, channelId: Id): boolean {
  return forSession(store).unavailable.has(String(channelId));
}

/** Reconcile authoritative availability without disturbing a different active scope. */
export async function reconcileChannels(store: AppStore, channels: Channel[]): Promise<void> {
  const session = forSession(store);
  const before = store.getState();
  const readable = channels.filter((channel) => !session.unavailable.has(String(channel.id)));
  const readableIds = new Set(readable.map((channel) => String(channel.id)));
  const removed = new Set(before.channels
    .filter((channel) => !readableIds.has(String(channel.id)))
    .map((channel) => String(channel.id)));
  const lostSelection = before.activeChannelId != null
    && !readableIds.has(String(before.activeChannelId));
  if (lostSelection) removed.add(String(before.activeChannelId));
  for (const id of removed) {
    session.unavailable.add(id);
    invalidateScopeRequests(store, "channel", id);
    removeCachedChat(store, "channel", id);
    store.dispatch({ type: "REMOVE_CHANNEL_SCOPE", payload: id });
  }
  store.dispatch({ type: "SET_CHANNELS", payload: readable });

  if (lostSelection && before.activeView === "channel") {
    if (hasPermission(store.getState(), "private_agent")) {
      await navigateToView(store, "private");
    } else if (readable[0]) {
      await selectChannel(store, readable[0].id);
    } else {
      // Keep the formal channel view with no scope: its empty state mounts no
      // composer/preview and all channel-owned surfaces have been cleared.
      await navigateToView(store, "channel");
    }
  } else if (store.getState().activeChannelId == null && readable[0]) {
    if (before.activeView === "channel") await selectChannel(store, readable[0].id);
    else store.dispatch({ type: "SET_ACTIVE_CHANNEL_ID", payload: readable[0].id });
  }
}

/** A confirmed DELETE or access-loss response is itself an availability fence. */
export async function removeUnavailableChannel(store: AppStore, channelId: Id): Promise<void> {
  const id = String(channelId);
  forSession(store).unavailable.add(id);
  // Also invalidate IDs absent from the latest list (for example a cleanup retry).
  invalidateScopeRequests(store, "channel", id);
  removeCachedChat(store, "channel", id);
  if (
    String(store.getState().activeChannelId) !== id
    && !store.getState().channels.some((channel) => String(channel.id) === id)
  ) store.dispatch({ type: "REMOVE_CHANNEL_SCOPE", payload: id });
  await reconcileChannels(store, store.getState().channels.filter((channel) => String(channel.id) !== id));
}
