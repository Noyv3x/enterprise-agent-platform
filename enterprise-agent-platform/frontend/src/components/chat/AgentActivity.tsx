/* <AgentActivity/> — the live agent bubble shown while a run is active AND has
   tool-call steps: a bot avatar + the active work card. */

import { cx } from "../../lib/cx";
import type { AgentStatus } from "../../types";
import { Icon } from "../common/Icon";
import { BrowserWorkPreview } from "../preview/BrowserWorkPreview";
import { useChatPreviewContext } from "../preview/ChatPreviewContext";
import { AgentWorkCard, hasAgentBrowserStep } from "./AgentWorkCard";

export function AgentActivity({
  status,
}: {
  status: AgentStatus;
}) {
  const preview = useChatPreviewContext();
  const showBrowserPreview = Boolean(
    preview?.scope
    && !preview.browserDrawerOpen
    && hasAgentBrowserStep(status),
  );

  return (
    <article className="msg msg--agent msg--activity">
      <div className="msg__avatar">
        <Icon name="bot" size={18} />
      </div>
      <div className={cx("agent-activity__content", showBrowserPreview && "has-browser-preview")}>
        <AgentWorkCard work={status} active={true} />
        {showBrowserPreview && preview?.scope ? (
          <BrowserWorkPreview
            scope={preview.scope}
            onTakeControl={preview.openBrowserAssist}
          />
        ) : null}
      </div>
    </article>
  );
}
