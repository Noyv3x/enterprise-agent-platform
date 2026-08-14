import { Button, Tooltip } from "antd";
import { useI18n, type MessageKey } from "../../i18n";
import type { ComputerMode } from "../../types";
import { Icon } from "../common/Icon";
import { Skeleton } from "../common/Skeleton";
import { useChatPreviewContext } from "./ChatPreviewContext";
import { useBrowserPreview } from "./useBrowserPreview";

const MODE_LABELS: Record<ComputerMode, MessageKey> = {
  file: "computer.mode.file",
  terminal: "computer.mode.terminal",
  browser: "computer.mode.browser",
  search: "computer.mode.search",
  present: "computer.mode.present",
};

export function ComputerPip() {
  const { t } = useI18n();
  const preview = useChatPreviewContext();
  const surface = preview?.computerSurface;
  const drawerOpen = preview?.computerDrawerOpen === true;
  const consumeBrowser = Boolean(
    preview?.scope && surface?.visible && surface.mode === "browser" && !drawerOpen,
  );
  const { state } = useBrowserPreview(consumeBrowser ? preview?.scope || null : null);
  if (!preview?.scope || !surface?.visible || drawerOpen) return null;

  const label = t("computer.show");
  const hasFrame = Boolean(state.frameUrl) && surface.mode === "browser";
  const showSkeleton = surface.live && (
    (surface.mode === "browser" && !hasFrame)
    || (surface.mode === "file" && !surface.file?.path && !surface.file?.workspace_path)
    || (surface.mode === "search" && !surface.searchHits.length)
    || surface.mode === "present"
    || surface.mode === "terminal"
  );

  return (
    <div className="computer-pip">
      <Tooltip title={label}>
        <Button
          className="computer-pip__button"
          type="text"
          aria-label={label}
          onClick={() => preview.openComputer()}
        >
          <span className="computer-pip__frame">
            {hasFrame ? (
              <img src={state.frameUrl} alt="" draggable={false} />
            ) : showSkeleton ? (
              <Skeleton className="computer-pip__skeleton" width="100%" height="100%" label={t("computer.loading")} />
            ) : (
              <span className="computer-pip__idle">
                <Icon name="computer" size={22} />
              </span>
            )}
            <span className="computer-pip__caption">
              <Icon name="computer" size={14} />
              <span>
                <strong>{t("computer.title")}</strong>
                <small>
                  {surface.live
                    ? t("computer.pip.live")
                    : surface.mode
                      ? t(MODE_LABELS[surface.mode])
                      : t("computer.show")}
                </small>
              </span>
            </span>
          </span>
        </Button>
      </Tooltip>
    </div>
  );
}
