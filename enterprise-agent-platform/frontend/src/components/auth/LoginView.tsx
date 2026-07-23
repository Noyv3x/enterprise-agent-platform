/* The established split-screen login treatment is product-owned; Ant Design
   supplies form controls, validation semantics, loading, and inline feedback. */

import { Alert, Button, Form, Input } from "antd";
import { useState } from "react";
import { login, runBusy } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { Brand } from "../common/Brand";
import { LanguageSelect } from "../common/LanguageSelect";

export function LoginView() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.pendingOperations.includes("auth:login"));
  const error = useStore((state) => state.error);
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <main className="auth auth--login">
      <aside className="auth__aside">
        <img className="auth__logo" src="/ubitech-logo.png" alt="ubitech" />
      </aside>
      <div className="auth__main">
        <section className="auth__card">
          <div className="auth__locale"><LanguageSelect /></div>
          <Brand />
          <h1>{t("auth.login")}</h1>
          <Form
            className="auth__form"
            layout="vertical"
            requiredMark={false}
            onFinish={() => {
              void runBusy(store, "auth:login", () => login(store, username, password));
            }}
          >
            <Form.Item className="auth__field" label={t("auth.username")} htmlFor="login-username" required>
              <Input
                id="login-username"
                name="username"
                autoComplete="username"
                required
                placeholder={t("auth.username")}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? "login-error" : undefined}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                classNames={{ root: "auth-input__root", input: "auth-input__control" }}
              />
            </Form.Item>
            <Form.Item className="auth__field" label={t("auth.password")} htmlFor="login-password" required>
              <Input.Password
                id="login-password"
                name="password"
                autoComplete="current-password"
                required
                placeholder={t("auth.password")}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? "login-error" : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                classNames={{ root: "auth-input__root", input: "auth-input__control" }}
              />
            </Form.Item>
            <Button
              className="auth__submit"
              type="primary"
              size="large"
              htmlType="submit"
              block
              loading={busy}
              disabled={busy}
            >
              {busy ? t("auth.loggingIn") : t("auth.login")}
            </Button>
            {error ? (
              <Alert className="auth__error" id="login-error" type="error" showIcon title={error} />
            ) : null}
          </Form>
        </section>
      </div>
    </main>
  );
}
