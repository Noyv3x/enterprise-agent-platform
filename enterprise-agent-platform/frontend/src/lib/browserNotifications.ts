const STORAGE_PREFIX = "ubitech.reply-notifications:";
const CHANGE_EVENT = "ubitech-reply-notifications-change";

function storageKey(userId: string | number): string {
  return `${STORAGE_PREFIX}${String(userId)}`;
}

export function browserNotificationsSupported(): boolean {
  return typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof Notification !== "undefined";
}

export function browserNotificationsEnabled(userId: string | number): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(storageKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function setBrowserNotificationsEnabled(
  userId: string | number,
  enabled: boolean,
): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(storageKey(userId), "1");
    else window.localStorage.removeItem(storageKey(userId));
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
    detail: { userId: String(userId), enabled },
  }));
}

export function subscribeBrowserNotifications(
  userId: string | number,
  listener: (enabled: boolean) => void,
): () => void {
  const expected = String(userId);
  const onChange = (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: string; enabled?: boolean }>).detail;
    if (detail?.userId === expected) listener(Boolean(detail.enabled));
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}
