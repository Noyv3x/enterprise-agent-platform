/* Sign-in: one centered window card on the canvas (harness window: 14px radius, hairline, page fill) with the
 * brand, two fields and the ink primary button. Behavior unchanged: POST /api/auth/login, then the shell reloads
 * the session; the server's reason shows as a danger notice. */
import { useRef, useState } from "react";
import { request } from "../api";
import { Button } from "../components/ui/beautiful/atoms/Button";
import { Field, Notice, TextField } from "../components/ui/beautiful/controls";
import { useBranding } from "../context/BrandingContext";
import { useWords } from "../words";
import { BrandMark } from "./BrandMark";
import { PreferenceCorner } from "./preferences";

export function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const { branding } = useBranding();
  const w = useWords();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<{ username: boolean; password: boolean }>({ username: false, password: false });
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit() {
    const empty = { username: !username.trim(), password: !password };
    setMissing(empty);
    if (empty.username || empty.password) {
      (empty.username ? usernameRef : passwordRef).current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      await onLogin();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas text-ink">
      <div className="flex justify-end p-2.5">
        <PreferenceCorner />
      </div>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16 sm:items-center sm:pt-0">
        <div className="bui-window w-full max-w-[380px] overflow-hidden rounded-window border border-line bg-page" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <div className="flex items-center gap-2 border-b border-line px-5 py-3">
            <BrandMark name={branding.product_name} logoUrl={branding.logo_url} />
            <span className="min-w-0 truncate text-[14px] font-medium text-ink-2">{branding.product_name}</span>
          </div>
          <form
            noValidate
            aria-labelledby="login-title"
            className="flex flex-col gap-4 px-5 pt-5 pb-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div>
              <h1 id="login-title" className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{w("Sign in", "登录", "登入")}</h1>
              <p className="mt-1 text-[13px] text-ink-2">{w("Use the account your administrator gave you.", "使用管理员为你创建的账户。", "使用管理員為你建立的帳戶。")}</p>
            </div>
            {error && <Notice tone="danger" title={error} />}
            <Field label={w("Username", "用户名", "使用者名稱")} error={missing.username ? w("Enter your username", "请输入用户名", "請輸入使用者名稱") : undefined}>
              <TextField
                ref={usernameRef}
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  if (missing.username) setMissing((current) => ({ ...current, username: false }));
                }}
              />
            </Field>
            <Field label={w("Password", "密码", "密碼")} error={missing.password ? w("Enter your password", "请输入密码", "請輸入密碼") : undefined}>
              <TextField
                ref={passwordRef}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (missing.password) setMissing((current) => ({ ...current, password: false }));
                }}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy} aria-busy={busy || undefined} className="mt-1 h-9 w-full touch:h-11">
              {busy ? w("Signing in…", "正在登录…", "正在登入…") : w("Sign in", "登录", "登入")}
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
