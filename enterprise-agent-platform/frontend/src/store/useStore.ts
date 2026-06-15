/* useStore — selector subscription over the hand-rolled store via
   useSyncExternalStore. The selected value is cached in a ref and only a new
   reference is returned when !isEqual, which prevents tearing and needless
   re-renders (a draft keystroke must not re-render the admin panel). */

import { useCallback, useContext, useRef, useSyncExternalStore } from "react";
import type { Store } from "../lib/store";
import type { Action, AppState } from "../types";
import { StoreContext } from "./StoreProvider";

export function useStoreHandle(): Store<AppState, Action> {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useStore must be used within a <StoreProvider>");
  }
  return store;
}

export function useStore<T>(
  selector: (state: AppState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useStoreHandle();
  const cache = useRef<{ value: T } | null>(null);

  const getSnapshot = useCallback(() => {
    const next = selector(store.getState());
    const previous = cache.current;
    if (previous && isEqual(previous.value, next)) {
      return previous.value;
    }
    cache.current = { value: next };
    return next;
    // selector/isEqual are commonly inline; the ref cache keeps the returned
    // value stable across renders so useSyncExternalStore stays happy.
  }, [store, selector, isEqual]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useDispatch(): (action: Action) => void {
  return useStoreHandle().dispatch;
}
