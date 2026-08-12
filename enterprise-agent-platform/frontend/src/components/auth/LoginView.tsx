/* The established split-screen login treatment is product-owned; Ant Design
   supplies form controls, validation semantics, loading, and inline feedback. */

import { Alert, Button, Form, Input } from "antd";
import { useEffect, useState } from "react";
import { login, runBusy } from "../../data/sessionActions";
import { isApiError } from "../../lib/api";
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
  const [retryAt, setRetryAt] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);

  useEffect(() => {
    if (!retryAt) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
      setRetrySeconds(remaining);
      if (remaining === 0) {
        setRetryAt(0);
        store.dispatch({ type: "SET_ERROR", payload: "" });
      }
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [retryAt, store]);

  const displayedError = retrySeconds > 0
    ? t("auth.rateLimited", { count: retrySeconds })
    : error;

  return (
    <main className="auth auth--login">
      <aside className="auth__aside">
        <Brand className="auth__logo" />
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
              if (retrySeconds > 0) return;
              void runBusy(store, "auth:login", async () => {
                try {
                  await login(store, username, password);
                } catch (loginError) {
                  if (isApiError(loginError, 429) && loginError.code === "login_rate_limited") {
                    const seconds = loginError.retryAfterSeconds ?? 60;
                    setRetryAt(Date.now() + seconds * 1_000);
                    setRetrySeconds(seconds);
                    throw new Error(t("auth.rateLimited", { count: seconds }));
                  }
                  throw loginError;
                }
              });
            }}
          >
            <Form.Item className="auth__field" label={t("auth.username")} htmlFor="login-username" required>
              <Input
                id="login-username"
                name="username"
                autoComplete="username"
                required
                placeholder={t("auth.username")}
                aria-invalid={!!displayedError || undefined}
                aria-describedby={displayedError ? "login-error" : undefined}
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
                aria-invalid={!!displayedError || undefined}
                aria-describedby={displayedError ? "login-error" : undefined}
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
              disabled={busy || retrySeconds > 0}
            >
              {busy
                ? t("auth.loggingIn")
                : retrySeconds > 0
                  ? t("auth.retryIn", { count: retrySeconds })
                  : t("auth.login")}
            </Button>
            {displayedError ? (
              <Alert className="auth__error" id="login-error" type="error" showIcon title={displayedError} />
            ) : null}
          </Form>
        </section>
      </div>
    </main>
  );
}
