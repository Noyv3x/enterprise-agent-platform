/* Hash routes and their permission gates. Server authorization stays authoritative; this only hides and blocks
 * areas the session cannot use. */

export type Route =
  | { view: "private" }
  | { view: "channels" }
  | { view: "channel"; id: number }
  | { view: "chat"; id: string | null }
  | { view: "admin" }
  | { view: "settings" }
  | { view: "unknown" };

export interface Access {
  admin: boolean;
  private: boolean;
  channels: boolean;
  chat: boolean;
}

export function accessFor(role: string, permissions: readonly string[]): Access {
  const admin = role === "admin";
  return {
    admin,
    private: admin || permissions.includes("private_agent"),
    channels: admin || permissions.includes("read_workspace"),
    chat: admin || permissions.includes("chat"),
  };
}

export function parseRoute(hash: string): Route {
  const key = hash.replace(/^#/, "") || "private";
  if (key === "private") return { view: "private" };
  if (key === "channels") return { view: "channels" };
  const channel = /^channel-(\d+)$/.exec(key);
  if (channel) return { view: "channel", id: Number(channel[1]) };
  if (key === "chat") return { view: "chat", id: null };
  if (key.startsWith("chat-") && key.length > 5) {
    try {
      return { view: "chat", id: decodeURIComponent(key.slice(5)) };
    } catch {
      return { view: "unknown" };
    }
  }
  if (key === "admin" || key.startsWith("admin/")) return { view: "admin" };
  if (key === "settings") return { view: "settings" };
  return { view: "unknown" };
}

export function allowed(route: Route, access: Access): boolean {
  switch (route.view) {
    case "private":
      return access.private;
    case "channels":
    case "channel":
      return access.channels;
    case "chat":
      return access.chat;
    case "admin":
      return access.admin;
    default:
      return true;
  }
}

/** The primary-nav row a route lights up (the area); a specific channel or chat also lights its list row. */
export function navKey(route: Route): string {
  switch (route.view) {
    case "channel":
      return "channels";
    case "unknown":
      return "";
    default:
      return route.view;
  }
}

/** First area the session may open, for a bare or unknown address. */
export function homeRoute(access: Access): string {
  if (access.private) return "private";
  if (access.chat) return "chat";
  if (access.channels) return "channels";
  return "settings";
}

/** The page to replace the address with once the session is known, or null to stay. `entering` is the first
 * resolution after entering the app or signing in (not a reload or back/forward): it opens Personal AI whenever the
 * session may use it, unless the address names a specific chat or channel. */
export function landingRoute(hash: string, access: Access, entering: boolean): string | null {
  const route = parseRoute(hash);
  const specific = route.view === "channel" || (route.view === "chat" && route.id !== null);
  if (entering && access.private && !specific) return hash === "private" ? null : "private";
  if (hash === "" || route.view === "unknown") return homeRoute(access);
  return null;
}
