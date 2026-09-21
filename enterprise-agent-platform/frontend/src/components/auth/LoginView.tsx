import { Button, Form, Input } from "antd";
import { useEffect, useState } from "react";
import { useBranding } from "../../context/BrandingContext";
import { login, runBusy } from "../../data/sessionActions";
import { isApiError } from "../../lib/api";
import { useStore, useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { AuthPage, FormFooter, Notice } from "../ui/fieldwork";
import { PublicUtilities } from "../ui/PublicUtilities";

export function LoginView() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.pendingOperations.includes("auth:login"));
  const error = useStore((state) => state.error);
  const { t } = useI18n();
  const { branding } = useBranding();
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
    <AuthPage
      brand={{ productName: branding.product_name, logoUrl: branding.logo_url }}
      title={t("auth.login")}
      footnote={t("workroom.authFootnote")}
      utilities={<PublicUtilities />}
      form={
        <Form
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
          <Form.Item label={t("auth.username")} htmlFor="login-username" required>
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
            />
          </Form.Item>
          <Form.Item label={t("auth.password")} htmlFor="login-password" required>
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
            />
          </Form.Item>
          {displayedError && <div id="login-error"><Notice tone="danger" title={displayedError} /></div>}
          <FormFooter>
            <Button type="primary" htmlType="submit" loading={busy} disabled={busy || retrySeconds > 0}>
              {busy ? t("auth.loggingIn") : retrySeconds > 0 ? t("auth.retryIn", { count: retrySeconds }) : t("auth.login")}
            </Button>
          </FormFooter>
        </Form>
      }
    />
  );
}
