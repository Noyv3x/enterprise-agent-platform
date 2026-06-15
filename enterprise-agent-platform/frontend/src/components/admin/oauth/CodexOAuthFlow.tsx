/* <CodexOAuthFlow/> — device-code verification UI: verification URL, user code, a
   manual "检查状态" poll button, and the status label (legacy renderCodexOAuthFlow,
   legacy-app.js:2748-2760). No auto-poll — the user clicks to poll. The
   backend-supplied verification_url is run through safeUrl (JSX does not block
   javascript: hrefs). */

import { pollOAuthVerification } from "../../../data/adminActions";
import { safeUrl } from "../../../lib/api";
import { useStore, useStoreHandle } from "../../../store/useStore";
import { oauthStatusLabel } from "../../../utils/oauth";
import type { OAuthDeviceCodeFlow } from "../../../types";
import { Icon } from "../../common/Icon";

export interface CodexOAuthFlowProps {
  providerId: string;
  flow: OAuthDeviceCodeFlow;
}

export function CodexOAuthFlow({ providerId, flow }: CodexOAuthFlowProps) {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);

  return (
    <div className="oauth-guide">
      <div className="oauth-line">
        <span>验证页</span>
        <a href={safeUrl(flow.verification_url)} target="_blank" rel="noreferrer">
          <span>{flow.verification_url}</span>
          <Icon name="external" size={13} />
        </a>
      </div>
      <div className="oauth-code">{flow.user_code}</div>
      <div className="oauth-actions">
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void pollOAuthVerification(store, providerId, flow.flow_id)}
        >
          <Icon name="refresh" size={14} />
          <span>检查状态</span>
        </button>
        <span className="muted" style={{ fontSize: "12px" }} aria-live="polite">
          {`状态：${oauthStatusLabel(flow.status)}`}
        </span>
      </div>
    </div>
  );
}
