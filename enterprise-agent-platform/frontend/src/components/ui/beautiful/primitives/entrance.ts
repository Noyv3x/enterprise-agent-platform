/* Platform addition (not upstream): which trace rows play their entrance animation. A row decides once, when it
 * mounts: rows that arrive while their trace is open for live work, or after it first rendered, are new and animate;
 * rows a settled trace already had at its first render (restored history, a persisted reply) appear in place.
 * Without a scope every row animates, as upstream. */
import { createContext, useContext, useEffect, useState } from "react";

/** Mutable on purpose: rows read it once at mount, so later changes never re-render them. */
export type Entrance = { current: boolean };

export const EntranceContext = createContext<Entrance>({ current: true });

/** The scope a trace gives its rows: `live` at its first render, then always new. */
export function useEntranceScope(live: boolean): Entrance {
  const [scope] = useState<Entrance>(() => ({ current: live }));
  useEffect(() => {
    scope.current = true;
  }, [scope]);
  return scope;
}

/** True when this row mounted as new content; fixed for the row's lifetime. */
export function useEntering(): boolean {
  const scope = useContext(EntranceContext);
  const [entering] = useState(() => scope.current);
  return entering;
}
