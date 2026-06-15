/* <GrokOAuthFlow/> — manual-callback verification UI: open the authorize URL,
   show the redirect URI, paste the full callback URL, and complete verification
   (legacy renderGrokOAuthFlow, legacy-app.js:2762-2780). The callback textarea is
   controlled by store state (oauthCallbackUrls[providerId]) — the same place
   completeOAuthVerification reads from. The backend-supplied authorize_url runs
   through safeUrl. */

import { completeOAuthVerification, setOAuthCallbackUrl } from "../../../data/adminActions";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { oauthStatusLabel } from "../../../utils/oauth";
import type { OAuthManualCallbackFlow } from "../../../types";
import { Icon } from "../../common/Icon";

export interface GrokOAuthFlowProps {
  providerId: string;
  flow: OAuthManualCallbackFlow;
  callbackValue: string;
}

export function GrokOAuthFlow({ providerId, flow, callbackValue }: GrokOAuthFlowProps) {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);

  return (
    <div className="oauth-guide">
      <div className="oauth-line">
        <span>授权页</span>
        <a href={safeUrl(flow.authorize_url)} target="_blank" rel="noreferrer">
          <span>打开 Grok OAuth</span>
          <Icon name="external" size={13} />
        </a>
      </div>
      <div className="oauth-line">
        <span>回调地址</span>
        <code>{flow.redirect_uri}</code>
      </div>
      <textarea
        placeholder="粘贴浏览器跳转后的完整 callback URL"
        value={callbackValue}
        onChange={(event) => setOAuthCallbackUrl(store, providerId, event.target.value)}
      />
      <div className="oauth-actions">
        <button
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={() => void completeOAuthVerification(store, providerId, flow.flow_id)}
        >
          <Icon name="checkCircle" size={14} />
          <span>完成验证</span>
        </button>
        <span className="muted" style={{ fontSize: "12px" }} aria-live="polite">
          {`状态：${oauthStatusLabel(flow.status)}`}
        </span>
      </div>
    </div>
  );
}
