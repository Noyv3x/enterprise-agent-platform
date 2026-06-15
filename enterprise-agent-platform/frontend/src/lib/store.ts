/* =====================================================================
   Minimal hand-rolled store over a ref + listener set, designed to back
   useSyncExternalStore (see store/useStore.ts). Zero dependencies; gives
   Zustand-like selective subscription without a library (plan §2.1).
   ===================================================================== */

export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<S, A>(reducer: (state: S, action: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState() {
      return state;
    },
    dispatch(action) {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      // Snapshot the listener set so unsubscribes during notification are safe.
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
