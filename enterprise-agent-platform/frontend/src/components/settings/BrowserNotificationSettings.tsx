import { Switch } from "../ui/beautiful";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { browserNotificationsEnabled, browserNotificationsSupported, setBrowserNotificationsEnabled } from "../../lib/browserNotifications";
import type { Id } from "../../types";
import { FormFooter, Notice, Section } from "../ui/beautiful";

export function BrowserNotificationSettings({ userId }: { userId: Id }) {
  const { t } = useI18n();
  const supported = browserNotificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(() => typeof Notification === "undefined" ? "denied" : Notification.permission);
  const [enabled, setEnabled] = useState(() => browserNotificationsEnabled(userId));
  const [pending, setPending] = useState(false);
  const owner = useRef(userId);
  const request = useRef(0);
  const busy = useRef(false);
  owner.current = userId;
  useEffect(() => {
    setEnabled(browserNotificationsEnabled(userId));
    setPermission(typeof Notification === "undefined" ? "denied" : Notification.permission);
    setPending(false); busy.current = false;
    return () => { request.current += 1; };
  }, [userId]);
  const toggle = async (checked: boolean) => {
    if (busy.current) return;
    if (!checked) { setBrowserNotificationsEnabled(userId, false); setEnabled(false); return; }
    if (!supported) return;
    const capturedUser = userId;
    const version = ++request.current;
    busy.current = true; setPending(true);
    try {
      let next = Notification.permission;
      if (next === "default") next = await Notification.requestPermission();
      if (version !== request.current || String(owner.current) !== String(capturedUser)) return;
      setPermission(next);
      setBrowserNotificationsEnabled(capturedUser, next === "granted");
      setEnabled(next === "granted");
    } catch {
      if (version === request.current) {
        setPermission(Notification.permission);
        setBrowserNotificationsEnabled(capturedUser, false); setEnabled(false);
      }
    } finally {
      if (version === request.current) { busy.current = false; setPending(false); }
    }
  };
  const state = !supported ? "notifications.settings.unsupported" : permission === "denied" ? "notifications.settings.denied" : permission === "default" ? "notifications.settings.permissionDefault" : enabled ? "notifications.settings.enabled" : "notifications.settings.disabled";
  return <Section title={t("notifications.settings.title")} description={t("notifications.settings.description")}>
    <FormFooter note={t("notifications.settings.replyComplete")}>
      <span aria-busy={pending}><Switch aria-label={t("notifications.settings.replyComplete")} checked={supported && permission === "granted" && enabled} disabled={!supported || permission === "denied" || pending} onChange={(checked) => void toggle(checked)} /></span>
    </FormFooter>
    <Notice tone={!supported || permission === "denied" ? "warning" : "info"} title={t(state)} />
  </Section>;
}
