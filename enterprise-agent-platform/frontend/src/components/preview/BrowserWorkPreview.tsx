import { Button } from "antd";
import { useI18n } from "../../i18n";
import type { AgentPreviewScope } from "../../types";
import { Icon } from "../common/Icon";
import { Skeleton } from "../common/Skeleton";
import { useBrowserPreview } from "./useBrowserPreview";

interface BrowserWorkPreviewProps {
  scope: AgentPreviewScope;
  onTakeControl: () => void;
}

export function BrowserWorkPreview({ scope, onTakeControl }: BrowserWorkPreviewProps) {
  const { t } = useI18n();
  const { state } = useBrowserPreview(scope);
  const hasFrame = Boolean(state.frameUrl);

  return (
    <Button
      className="agent-browser-peek"
      type="text"
      aria-label={t("browserPreview.workTakeControl")}
      onClick={onTakeControl}
    >
      <span className="agent-browser-peek__frame">
        {hasFrame ? (
          <img
            src={state.frameUrl}
            alt={t("browserPreview.workFrameAlt")}
            draggable={false}
          />
        ) : (
          <span
            className="agent-browser-peek__loading"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <Skeleton
              className="agent-browser-peek__skeleton"
              width="100%"
              height="100%"
              label={t("browserPreview.workLoading")}
            />
          </span>
        )}
        <span className="agent-browser-peek__caption">
          <Icon name="browser" size={14} />
          <span>
            <strong>{t("browserPreview.workTitle")}</strong>
            <small>
              {hasFrame
                ? t("browserPreview.workTakeControl")
                : t("browserPreview.workLoading")}
            </small>
          </span>
        </span>
      </span>
    </Button>
  );
}
