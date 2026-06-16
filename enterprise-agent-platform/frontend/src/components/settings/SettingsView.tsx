import { useEffect, useState, type FormEvent } from "react";
import { changePassword, updateCurrentUser } from "../../data/accountActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { CardHead } from "../common/CardHead";
import { EmptyState } from "../common/EmptyState";
import { Field } from "../common/Field";

const MIN_PASSWORD_LENGTH = 8;

export function SettingsView() {
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  const busy = useStore((state) => state.busy);

  const [displayName, setDisplayName] = useState("");
  const [position, setPosition] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  useEffect(() => {
    setDisplayName(user?.display_name || user?.username || "");
    setPosition(user?.position || "");
  }, [user?.display_name, user?.id, user?.position, user?.username]);

  if (!user) {
    return (
      <div className="panel">
        <div className="panel__inner">
          <EmptyState icon="settings" title="需要登录" text="请登录后查看账户设置。" />
        </div>
      </div>
    );
  }

  const permissionLabel = user.permission_group_label || user.permission_group || user.role || "member";

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
      setPasswordError("两次输入的新密码不一致");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`新密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
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
          <CardHead title="账户资料" icon="settings" />
          <form onSubmit={handleProfileSubmit}>
            <div className="settings-form__grid">
              <Field label="用户名">
                <input value={user.username} disabled />
              </Field>
              <Field label="权限组">
                <input value={permissionLabel} disabled />
              </Field>
              <Field label="显示名称">
                <input
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field label="职位">
                <input
                  autoComplete="organization-title"
                  placeholder="职位"
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn btn--primary" type="submit" disabled={busy}>
                <span>保存资料</span>
              </button>
            </div>
          </form>
        </section>

        <section className="card settings-card">
          <CardHead title="修改密码" icon="key" />
          <form onSubmit={handlePasswordSubmit}>
            <div className="settings-form__grid">
              <Field label="当前密码">
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </Field>
              <Field label="新密码">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>
              <Field label="确认新密码">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </Field>
            </div>
            <div className="error settings-error" role="alert">
              {passwordError}
            </div>
            <div className="form-actions">
              <button className="btn btn--primary" type="submit" disabled={busy}>
                <span>更新密码</span>
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
