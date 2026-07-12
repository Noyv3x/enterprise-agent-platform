/* <LoginView/> — the unauthenticated split login screen (legacy renderLogin,
   legacy-app.js:367-404). Controlled username/password; submit runs through
   runBusy(login). Pre-login errors are shown INLINE in the .error[role=alert]
   box (runBusy only toasts once a user is present), preserving the legacy
   toast-vs-inline duality. The button shows a spinner + "正在登录…" while busy. */

import { useState } from "react";
import { login, runBusy } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { useI18n } from "../../i18n";
import { Brand } from "../common/Brand";
import { Field } from "../common/Field";
import { LanguageSelect } from "../common/LanguageSelect";
import { Spinner } from "../common/Spinner";

export function LoginView() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const error = useStore((state) => state.error);
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <main className="auth">
      <aside className="auth__aside">
        <img className="auth__logo" src="/ubitech-logo.png" alt="ubitech" />
      </aside>
      <div className="auth__main">
        <div className="auth__card">
          <div className="auth__locale"><LanguageSelect /></div>
          <Brand />
          <h1>{t("auth.login")}</h1>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runBusy(store, () => login(store, username, password));
            }}
          >
            <Field label={t("auth.username")}>
              <input
                name="username"
                autoComplete="username"
                placeholder={t("auth.username")}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field label={t("auth.password")}>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder={t("auth.password")}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={busy}>
              {busy ? <Spinner size={18} /> : null}
              <span>{busy ? t("auth.loggingIn") : t("auth.login")}</span>
            </button>
            <div className="error" role="alert">
              {error}
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
