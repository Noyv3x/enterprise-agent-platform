import { useEffect, useState } from "react";
import { request } from "../../api";
import { errorText } from "../conversation/useConversation";

/** A view URL is re-minted this long before its token expires (tokens live 2 hours). */
export const VIEW_REFRESH_LEAD_MS = 5 * 60 * 1000;

interface Minted { key: string; url: string; expiresAt: number }

/** A view URL (`/artifact-view/<token>/<entry>` for an artifact version, `/attachment-view/<token>/<name>` for an
 * attachment) minted on demand by POSTing to `mint` and re-minted before the token expires, also when a hidden tab
 * comes back after its timer was throttled. The previous URL stays until the new one arrives, so a frame never
 * blanks. `nonce` forces a fresh token (刷新). */
export function useViewUrl(mint: string | null, nonce = 0): { url: string | null; error: string } {
  const key = mint ?? "";
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer = 0;
    request<{ url: string; expires_at: string }>(key, { method: "POST", body: "{}" }).then(
      (result) => {
        if (cancelled) return;
        const expiresAt = Date.parse(result.expires_at);
        setMinted({ key, url: result.url, expiresAt });
        setError(null);
        if (Number.isFinite(expiresAt)) timer = window.setTimeout(() => setRound((value) => value + 1), Math.max(1000, expiresAt - Date.now() - VIEW_REFRESH_LEAD_MS));
      },
      (reason: unknown) => {
        if (!cancelled) setError({ key, text: errorText(reason) });
      },
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, nonce, round]);

  // Background tabs throttle timers: re-mint on return when the token is (nearly) spent.
  const expiresAt = minted?.key === key ? minted.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && expiresAt - Date.now() < VIEW_REFRESH_LEAD_MS) setRound((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [expiresAt]);

  return { url: minted?.key === key ? minted.url : null, error: error?.key === key ? error.text : "" };
}
