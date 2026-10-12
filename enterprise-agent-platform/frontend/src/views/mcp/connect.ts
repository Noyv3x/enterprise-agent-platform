import { request, type McpConnectorView } from "../../api";

/** The authorize page could not be opened (popup blocked). `url` is the authorize link to offer as a plain link;
 * the callback still reaches this window through the `mcp-oauth` broadcast channel. */
export class McpPopupBlocked extends Error {
  constructor(public url: string) { super("popup blocked"); }
}

/** What the OAuth callback page posts to `BroadcastChannel('mcp-oauth')`. The popup is cut from its opener before it
 * leaves this origin, so the channel is the only way back: the identity provider's pages never get a handle on this
 * window. */
type CallbackMessage = { type: "mcp-connected"; connector: number } | { type: "mcp-connect-failed"; connector: number | null; error?: string };

const PENDING_MS = 10 * 60_000; // Platform forgets a pending flow after 10 minutes
const CLOSED_POLL_MS = 500;

function callbackMessage(data: unknown): CallbackMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  return message.type === "mcp-connected" || message.type === "mcp-connect-failed" ? (message as CallbackMessage) : null;
}

/** Waits for the callback of connector `connectorId`: 'connected' on success; 'closed' when the window closed (or
 * the flow expired) without a message, which is not a failure (a browser without BroadcastChannel, or a callback
 * opened elsewhere), so the caller re-reads the connector status; rejects with the callback's error. */
export function waitForMcpConnected(connectorId: number, popup: Window | null): Promise<"connected" | "closed"> {
  return new Promise((resolve, reject) => {
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("mcp-oauth") : null;
    const finish = (settle: () => void) => {
      channel?.close();
      window.clearInterval(poll);
      window.clearTimeout(expiry);
      settle();
    };
    // BroadcastChannel only connects documents of this origin, so the sender is our own callback page.
    if (channel) channel.onmessage = (event) => {
      const message = callbackMessage(event.data);
      if (!message) return;
      if (message.type === "mcp-connected" && message.connector === connectorId) finish(() => resolve("connected"));
      else if (message.type === "mcp-connect-failed" && (message.connector === connectorId || message.connector === null)) {
        finish(() => reject(new Error(message.error || "OAuth sign-in failed")));
      }
    };
    // A closed window may still have a message in flight; give it one poll interval before settling.
    let closedSeen = false;
    const poll = window.setInterval(() => {
      if (!popup?.closed) return;
      if (closedSeen) finish(() => resolve("closed"));
      closedSeen = true;
    }, CLOSED_POLL_MS);
    const expiry = window.setTimeout(() => finish(() => resolve("closed")), PENDING_MS);
  });
}

/** An authorize URL the browser may open: https, or http only on this computer (a local test identity provider). */
function safeAuthorizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
  } catch {
    return null;
  }
}

/** Starts the OAuth sign-in of a connector. Call it synchronously from the click handler: it opens the popup before
 * the request so popup blockers allow it, cuts it from this window, then points it at the authorize URL that
 * `POST connectPath` returns. Rejects with the request's ApiError (`oauth_registration_required`,
 * `oauth_pkce_unsupported`, `oauth_https_required`, `confirmation_required`, …), with an Error for an authorize URL
 * that is not https (or loopback http), or with McpPopupBlocked; see waitForMcpConnected for the result. */
export async function connectMcp(connectPath: string, connectorId: number): Promise<"connected" | "closed"> {
  let popup = window.open("about:blank", "mcp-oauth", "popup,width=520,height=720");
  let authorizeUrl: string | null;
  try {
    authorizeUrl = safeAuthorizeUrl((await request<{ authorize_url: string }>(connectPath, { method: "POST", body: "{}" })).authorize_url);
  } catch (cause) {
    popup?.close();
    throw cause;
  }
  if (!authorizeUrl) {
    popup?.close();
    throw new Error("The sign-in address is not a secure (https) link, so it was not opened.");
  }
  if (popup && !popup.closed) {
    popup.opener = null;
    popup.location.href = authorizeUrl;
  } else {
    // `noopener` would make window.open return null, which reads as blocked; cut the opener by hand instead.
    popup = window.open(authorizeUrl, "_blank");
    if (popup) popup.opener = null;
  }
  if (!popup) {
    // Nothing opened; the caller offers the link and the broadcast channel still reports the result.
    void waitForMcpConnected(connectorId, null).catch(() => undefined);
    throw new McpPopupBlocked(authorizeUrl);
  }
  return waitForMcpConnected(connectorId, popup);
}

/** The user's own secret values for a connector (their personal connector, or a per-user organization one).
 * `null` deletes a value. Values are write-only: the response, like every view, says only which keys are set. */
export async function saveMcpSecrets(connectorId: number, secrets: Record<string, string | null>): Promise<McpConnectorView> {
  return (await request<{ connector: McpConnectorView }>(`/api/mcp/connectors/${connectorId}/credentials`, { method: "PUT", body: JSON.stringify({ secrets }) })).connector;
}
