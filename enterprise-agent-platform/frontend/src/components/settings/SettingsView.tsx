import { useEffect, useState, type FormEvent } from "react";
import { changePassword, updateCurrentUser } from "../../data/accountActions";
import { useI18n } from "../../i18n";
import { permissionGroupLabel } from "../../i18n/labels";
import { useStore, useStoreHandle } from "../../store/useStore";
import { CardHead } from "../common/CardHead";
import { EmptyState } from "../common/EmptyState";
import { Field } from "../common/Field";

const MIN_PASSWORD_LENGTH = 8;

export function SettingsView() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  const busy = useStore((state) => state.busy);

  const [displayName, setDisplayName] = useState("");
  const [position, setPosition] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<"mismatch" | "too-short" | "">("");

  useEffect(() => {
    setDisplayName(user?.display_name || user?.username || "");
    setPosition(user?.position || "");
  }, [user?.display_name, user?.id, user?.position, user?.username]);

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

  const handleProfileSubmit = (event: FormEvent) => {
    event.preventDefault();
    void updateCurrentUser(store, {
      display_name: displayName,
      position,
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
        <section className="card settings-card">
          <CardHead title={t("account.profile")} icon="settings" />
          <form onSubmit={handleProfileSubmit}>
            <div className="settings-form__grid">
              <Field label={t("account.username")}>
                <input value={user.username} disabled />
              </Field>
              <Field label={t("account.permissionGroup")}>
                <input value={permissionLabel} disabled />
              </Field>
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
            </div>
            <div className="form-actions">
              <button className="btn btn--primary" type="submit" disabled={busy}>
                <span>{t("account.saveProfile")}</span>
              </button>
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
              <button className="btn btn--primary" type="submit" disabled={busy}>
                <span>{t("account.updatePassword")}</span>
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
