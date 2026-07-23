import {
  Alert,
  AutoComplete,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useId, useMemo, useState } from "react";
import { browserTimezone, changePassword, updateCurrentUser } from "../../data/accountActions";
import { useI18n } from "../../i18n";
import { permissionGroupLabel } from "../../i18n/labels";
import { useStore, useStoreHandle } from "../../store/useStore";
import { initials } from "../../utils/format";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { PageHeader } from "../common/PageHeader";
import "./settings.css";

const MIN_PASSWORD_LENGTH = 8;

function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  let values: string[] = [];
  try {
    values = intl.supportedValuesOf?.("timeZone") || [];
  } catch {
    values = [];
  }
  return [...new Set([current, "UTC", ...values].filter(Boolean))];
}

export function SettingsView() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  const pendingOperations = useStore((state) => state.pendingOperations);

  const [displayName, setDisplayName] = useState("");
  const [position, setPosition] = useState("");
  const [timezone, setTimezone] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<"mismatch" | "too-short" | "">("");
  const formId = useId();
  const timezoneHintId = useId();
  const timezones = useMemo(() => timezoneOptions(timezone), [timezone]);

  useEffect(() => {
    setDisplayName(user?.display_name || user?.username || "");
    setPosition(user?.position || "");
  }, [user?.display_name, user?.id, user?.position, user?.username]);

  useEffect(() => {
    setTimezone(user?.timezone || browserTimezone() || "UTC");
  }, [user?.id, user?.timezone]);

  if (!user) {
    return (
      <div className="panel">
        <div className="panel__inner">
          <EmptyState
            icon="settings"
            title={t("session.loginRequired")}
            text={t("account.loginRequiredDetail")}
          />
        </div>
      </div>
    );
  }

  const permissionId = user.permission_group || user.role || "member";
  const permissionLabel = permissionGroupLabel(t, permissionId, user.permission_group_label);
  const profilePending = pendingOperations.includes("account:profile");
  const passwordPending = pendingOperations.includes("account:password");
  const profileDirty =
    displayName !== (user.display_name || user.username || "") ||
    position !== (user.position || "") ||
    timezone !== (user.timezone || "");
  const passwordDirty = !!(currentPassword || newPassword || confirmPassword);

  const handleProfileSubmit = () => {
    void updateCurrentUser(store, {
      display_name: displayName,
      position,
      timezone: timezone.trim(),
    });
  };

  const handlePasswordSubmit = () => {
    if (newPassword !== confirmPassword) {
      setPasswordError("mismatch");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError("too-short");
      return;
    }
    setPasswordError("");
    void changePassword(
      store,
      {
        current_password: currentPassword,
        new_password: newPassword,
      },
      () => {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      },
    );
  };

  return (
    <div className="panel">
      <div className="panel__inner settings-panel">
        <PageHeader
          title={t("nav.settings")}
          description={t("account.settingsDescription")}
        />
        <Card
          className="account-identity"
          classNames={{ body: "account-identity__body" }}
          aria-label={t("account.identitySummary")}
        >
          <Avatar className="account-identity__avatar" size={44}>
            {initials(user.display_name || user.username)}
          </Avatar>
          <div className="account-identity__main">
            <Typography.Text strong>{user.display_name || user.username}</Typography.Text>
            <Typography.Text type="secondary">@{user.username}</Typography.Text>
          </div>
          <div className="account-identity__meta">
            <Tag color="blue">{permissionLabel}</Tag>
            {user.position ? <Typography.Text type="secondary">{user.position}</Typography.Text> : null}
          </div>
        </Card>
        <Card
          className="settings-card"
          classNames={{ body: "settings-card__body" }}
          title={<Space><Icon name="settings" />{t("account.profile")}</Space>}
        >
          <Form layout="vertical" onFinish={handleProfileSubmit} requiredMark="optional">
            <div className="settings-form__grid">
              <Form.Item label={t("account.displayName")} htmlFor={`${formId}-display-name`}>
                <Input
                  id={`${formId}-display-name`}
                  aria-label={t("account.displayName")}
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Form.Item>
              <Form.Item label={t("account.position")} htmlFor={`${formId}-position`}>
                <Input
                  id={`${formId}-position`}
                  aria-label={t("account.position")}
                  autoComplete="organization-title"
                  placeholder={t("account.position")}
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                />
              </Form.Item>
              <Form.Item
                label={t("account.timezone")}
                htmlFor={`${formId}-timezone`}
                required
              >
                <div className="field-stack">
                  <AutoComplete
                    id={`${formId}-timezone`}
                    aria-label={t("account.timezone")}
                    options={timezones.map((item) => ({ value: item }))}
                    showSearch
                    virtual
                    value={timezone}
                    aria-describedby={timezoneHintId}
                    onChange={setTimezone}
                  />
                  <div className="field-help" id={timezoneHintId}>{t("account.timezoneHint")}</div>
                </div>
              </Form.Item>
            </div>
            <div className="form-actions">
              <Button
                htmlType="submit"
                type="primary"
                loading={profilePending}
                disabled={!profileDirty || !timezone.trim()}
              >
                {profilePending ? t("account.saving") : t("account.saveProfile")}
              </Button>
            </div>
          </Form>
        </Card>

        <Card
          className="settings-card"
          classNames={{ body: "settings-card__body" }}
          title={<Space><Icon name="key" />{t("account.changePassword")}</Space>}
        >
          <Form layout="vertical" onFinish={handlePasswordSubmit} requiredMark="optional">
            <div className="settings-form__grid">
              <Form.Item label={t("account.currentPassword")} htmlFor={`${formId}-current-password`}>
                <Input.Password
                  id={`${formId}-current-password`}
                  aria-label={t("account.currentPassword")}
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </Form.Item>
              <Form.Item label={t("account.newPassword")} htmlFor={`${formId}-new-password`}>
                <Input.Password
                  id={`${formId}-new-password`}
                  aria-label={t("account.newPassword")}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Form.Item>
              <Form.Item label={t("account.confirmPassword")} htmlFor={`${formId}-confirm-password`}>
                <Input.Password
                  id={`${formId}-confirm-password`}
                  aria-label={t("account.confirmPassword")}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </Form.Item>
            </div>
            {passwordError ? (
              <Alert
                className="settings-error"
                type="error"
                showIcon
                title={passwordError === "mismatch"
                  ? t("account.passwordMismatch")
                  : t("account.passwordMinLength", { count: MIN_PASSWORD_LENGTH })}
              />
            ) : null}
            <div className="form-actions">
              <Button
                htmlType="submit"
                type="primary"
                loading={passwordPending}
                disabled={!passwordDirty}
              >
                {passwordPending ? t("account.updatingPassword") : t("account.updatePassword")}
              </Button>
            </div>
          </Form>
        </Card>
      </div>
    </div>
  );
}
