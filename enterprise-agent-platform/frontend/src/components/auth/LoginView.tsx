/* <LoginView/> — the unauthenticated split login screen (legacy renderLogin,
   legacy-app.js:367-404). Controlled username/password; submit runs through
   runBusy(login). Pre-login errors are shown INLINE in the .error[role=alert]
   box (runBusy only toasts once a user is present), preserving the legacy
   toast-vs-inline duality. The button shows a spinner + "正在登录…" while busy. */

import { useState } from "react";
import { login, runBusy } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Brand } from "../common/Brand";
import { Field } from "../common/Field";
import { Spinner } from "../common/Spinner";

export function LoginView() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const error = useStore((state) => state.error);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <main className="auth">
      <aside className="auth__aside">
        <img className="auth__logo" src="/ubitech-logo.png" alt="ubitech" />
      </aside>
      <div className="auth__main">
        <div className="auth__card">
          <Brand />
          <h1>登录</h1>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runBusy(store, () => login(store, username, password));
            }}
          >
            <Field label="用户名">
              <input
                name="username"
                autoComplete="username"
                placeholder="用户名"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field label="密码">
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="密码"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={busy}>
              {busy ? <Spinner size={18} /> : null}
              <span>{busy ? "正在登录…" : "登录"}</span>
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
