import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { browserTimezone, changePassword, updateCurrentUser } from "../../data/accountActions";
import { useI18n } from "../../i18n";
import { permissionGroupLabel } from "../../i18n/labels";
import { useStore, useStoreHandle } from "../../store/useStore";
import { initials } from "../../utils/format";
import { CardHead } from "../common/CardHead";
import { EmptyState } from "../common/EmptyState";
import { Field } from "../common/Field";
import { LoadingButton } from "../common/LoadingButton";
import { PageHeader } from "../common/PageHeader";

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
  const timezoneListId = useId();
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

  const handleProfileSubmit = (event: FormEvent) => {
    event.preventDefault();
    void updateCurrentUser(store, {
      display_name: displayName,
      position,
      timezone: timezone.trim(),
    });
  };

  const handlePasswordSubmit = (event: FormEvent) => {
    event.preventDefault();
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
        <section className="account-identity" aria-label={t("account.identitySummary")}>
          <div className="avatar account-identity__avatar">
            {initials(user.display_name || user.username)}
          </div>
          <div className="account-identity__main">
            <strong>{user.display_name || user.username}</strong>
            <span>@{user.username}</span>
          </div>
          <div className="account-identity__meta">
            <span>{permissionLabel}</span>
            {user.position ? <span>{user.position}</span> : null}
          </div>
        </section>
        <section className="card settings-card">
          <CardHead title={t("account.profile")} icon="settings" />
          <form onSubmit={handleProfileSubmit}>
            <div className="settings-form__grid">
              <Field label={t("account.displayName")}>
                <input
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field label={t("account.position")}>
                <input
                  autoComplete="organization-title"
                  placeholder={t("account.position")}
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                />
              </Field>
              <Field label={t("account.timezone")}>
                <div className="field-stack">
                  <input
                    required
                    list={timezoneListId}
                    value={timezone}
                    aria-describedby={timezoneHintId}
                    onChange={(event) => setTimezone(event.target.value)}
                  />
                  <datalist id={timezoneListId}>
                    {timezones.map((item) => <option key={item} value={item} />)}
                  </datalist>
                  <div className="field-help" id={timezoneHintId}>{t("account.timezoneHint")}</div>
                </div>
              </Field>
            </div>
            <div className="form-actions">
              <LoadingButton
                type="submit"
                variant="primary"
                loading={profilePending}
                loadingLabel={t("account.saving")}
                disabled={!profileDirty || !timezone.trim()}
              >
                {t("account.saveProfile")}
              </LoadingButton>
            </div>
          </form>
        </section>

        <section className="card settings-card">
          <CardHead title={t("account.changePassword")} icon="key" />
          <form onSubmit={handlePasswordSubmit}>
            <div className="settings-form__grid">
              <Field label={t("account.currentPassword")}>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </Field>
              <Field label={t("account.newPassword")}>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>
              <Field label={t("account.confirmPassword")}>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </Field>
            </div>
            <div className="error settings-error" role="alert">
              {passwordError === "mismatch"
                ? t("account.passwordMismatch")
                : passwordError === "too-short"
                  ? t("account.passwordMinLength", { count: MIN_PASSWORD_LENGTH })
                  : ""}
            </div>
            <div className="form-actions">
              <LoadingButton
                type="submit"
                variant="primary"
                loading={passwordPending}
                loadingLabel={t("account.updatingPassword")}
                disabled={!passwordDirty}
              >
                {t("account.updatePassword")}
              </LoadingButton>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
