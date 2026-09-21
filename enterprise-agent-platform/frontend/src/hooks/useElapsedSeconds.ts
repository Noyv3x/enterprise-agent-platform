/* useElapsedSeconds ticks once per second while `live` and a valid UNIX-second
   start is known. It returns null otherwise so callers never invent a timer for
   historical or unstarted work. The interval restarts when `key` changes so a
   new run with the same start does not inherit a stale tick. */

import { useEffect, useState } from "react";

export function useElapsedSeconds(startedAt: number | null | undefined, live: boolean, key = ""): number | null {
  const timing = live && startedAt != null && Number.isFinite(startedAt) && startedAt > 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timing, key, startedAt]);
  return timing ? Math.max(0, (now - Number(startedAt) * 1000) / 1000) : null;
}
