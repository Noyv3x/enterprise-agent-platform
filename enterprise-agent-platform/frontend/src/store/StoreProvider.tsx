/* StoreProvider — creates the store exactly once (useRef) and provides the
   handle through context. The handle (getState/dispatch/subscribe) is stable,
   so context never causes re-renders; components subscribe selectively via
   useStore(). */

import { createContext, useRef, type ReactNode } from "react";
import { createStore, type Store } from "../lib/store";
import type { Action, AppState } from "../types";
import { initialAppState, rootReducer } from "./reducer";

export const StoreContext = createContext<Store<AppState, Action> | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Store<AppState, Action> | null>(null);
  if (!ref.current) {
    ref.current = createStore(rootReducer, initialAppState);
    // Dev-only: expose the store handle for visual QA seeding (mock state without
    // a backend). Tree-shaken out of production builds via the import.meta.env.DEV
    // guard, so it never ships.
    if (import.meta.env.DEV) {
      (globalThis as { __eapStore?: Store<AppState, Action> }).__eapStore = ref.current;
    }
  }
  return <StoreContext.Provider value={ref.current}>{children}</StoreContext.Provider>;
}
