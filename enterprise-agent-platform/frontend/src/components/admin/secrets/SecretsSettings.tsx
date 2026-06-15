/* <SecretsSettings/> — list + set platform-internal secrets, excluding OAuth
   secrets (managed by the OAuth card). Legacy renderSecretsSettings,
   legacy-app.js:2643-2666. */

import { useStore } from "../../../store/useStore";
import { isOAuthSecret } from "../../../utils/oauth";
import { CardHead } from "../../common/CardHead";
import { SecretRow } from "./SecretRow";

export function SecretsSettings() {
  const secrets = useStore((state) => state.secrets);
  const rows = secrets.filter((secret) => !isOAuthSecret(secret.key));

  return (
    <section className="card">
      <CardHead
        title="平台内部密钥"
        icon="key"
        desc="手动配置的平台级密钥，OAuth 凭据在上方管理。"
      />
      {rows.length ? (
        <div className="list">
          {rows.map((secret) => (
            <SecretRow key={secret.key} secret={secret} />
          ))}
        </div>
      ) : (
        <div className="muted">暂无可手动配置的内部密钥。</div>
      )}
    </section>
  );
}
