import { Alert, Card, Space, Switch, Typography } from "antd";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import {
  browserNotificationsEnabled,
  browserNotificationsSupported,
  setBrowserNotificationsEnabled,
} from "../../lib/browserNotifications";
import type { Id } from "../../types";
import { Icon } from "../common/Icon";

export function BrowserNotificationSettings({ userId }: { userId: Id }) {
  const { t } = useI18n();
  const supported = browserNotificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );
  const [enabled, setEnabled] = useState(() => browserNotificationsEnabled(userId));

  useEffect(() => {
    setEnabled(browserNotificationsEnabled(userId));
    setPermission(typeof Notification === "undefined" ? "denied" : Notification.permission);
  }, [userId]);

  const toggle = async (checked: boolean) => {
    if (!checked) {
      setBrowserNotificationsEnabled(userId, false);
      setEnabled(false);
      return;
    }
    if (!supported) return;
    let nextPermission = Notification.permission;
    if (nextPermission === "default") {
      nextPermission = await Notification.requestPermission();
    }
    setPermission(nextPermission);
    const nextEnabled = nextPermission === "granted";
    setBrowserNotificationsEnabled(userId, nextEnabled);
    setEnabled(nextEnabled);
  };

  return (
    <Card
      className="settings-card"
      classNames={{ body: "settings-card__body" }}
      title={<Space><Icon name="message" />{t("notifications.settings.title")}</Space>}
    >
      <div className="notification-setting">
        <div>
          <Typography.Text strong>{t("notifications.settings.replyComplete")}</Typography.Text>
          <Typography.Paragraph type="secondary">
            {t("notifications.settings.description")}
          </Typography.Paragraph>
        </div>
        <Switch
          checked={supported && permission === "granted" && enabled}
          disabled={!supported || permission === "denied"}
          aria-label={t("notifications.settings.replyComplete")}
          onChange={(checked) => void toggle(checked)}
        />
      </div>
      {!supported ? (
        <Alert role="status" type="warning" showIcon title={t("notifications.settings.unsupported")} />
      ) : permission === "denied" ? (
        <Alert role="status" type="warning" showIcon title={t("notifications.settings.denied")} />
      ) : null}
    </Card>
  );
}
