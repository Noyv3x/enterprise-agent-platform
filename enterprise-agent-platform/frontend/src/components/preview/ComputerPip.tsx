import { Button, Tooltip } from "antd";
import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import { cx } from "../../lib/cx";
import type { ComputerMode } from "../../types";
import { Icon } from "../common/Icon";
import { Skeleton } from "../common/Skeleton";
import { useChatPreviewContext } from "./ChatPreviewContext";
import { FileComputerView } from "./FileComputerView";
import { PresentComputerView } from "./PresentComputerView";
import { SearchComputerView } from "./SearchComputerView";
import { CompactTerminalPreview } from "./TerminalPreviewView";
import { useBrowserPreview } from "./useBrowserPreview";

const MODE_LABELS: Record<ComputerMode, MessageKey> = {
  file: "computer.mode.file",
  terminal: "computer.mode.terminal",
  browser: "computer.mode.browser",
  search: "computer.mode.search",
  present: "computer.mode.present",
};

const ELAPSED_TICK_MS = 1_000;

export function formatComputerElapsed(totalSeconds: number): string {
  const bounded = Math.max(0, Math.floor(totalSeconds));
  const seconds = bounded % 60;
  const totalMinutes = Math.floor(bounded / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pairs = [minutes, seconds].map((value) => String(value).padStart(2, "0"));
  return hours > 0
    ? [String(hours).padStart(2, "0"), ...pairs].join(":")
    : pairs.join(":");
}

function ComputerPipControl({
  label,
  title,
  live,
  runId,
  startedAt,
  modeLabel,
  activityLabel,
  onOpen,
}: {
  label: string;
  title: string;
  live: boolean;
  runId: string;
  startedAt: number | null;
  modeLabel: string;
  activityLabel: string;
  onOpen: (opener: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const timing = live && Boolean(runId) && startedAt != null && Number.isFinite(startedAt) && startedAt > 0;

  useEffect(() => {
    if (!timing) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(interval);
  }, [runId, startedAt, timing]);

  const elapsed = timing
    ? formatComputerElapsed(Math.max(0, (now - Number(startedAt) * 1_000) / 1_000))
    : "";
  const description = elapsed
    ? `${modeLabel} · ${activityLabel} · ${t("computer.pip.elapsed", { time: elapsed })}`
    : `${modeLabel} · ${activityLabel}`;
  return (
    <Tooltip title={label}>
      <Button
        className="computer-pip__button"
        type="text"
        aria-label={label}
        aria-description={description}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="computer-pip__caption">
          <span className="computer-pip__status" aria-hidden="true" />
          <Icon name="computer" size={13} />
          <span className="computer-pip__copy">
            <strong>{title}</strong>
            <small>{modeLabel} · {activityLabel}</small>
          </span>
          {elapsed ? <span className="computer-pip__elapsed" aria-hidden="true">{elapsed}</span> : null}
        </span>
      </Button>
    </Tooltip>
  );
}

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
  const modeLabel = surface.mode ? t(MODE_LABELS[surface.mode]) : t("computer.title");
  const activityLabel = surface.live ? t("computer.pip.live") : t("preview.readOnly");
  const hasFrame = Boolean(state.frameUrl) && surface.mode === "browser";
  const latestStatus = String(surface.latestStep?.tool_status || "running").toLowerCase();
  const latestStepRunning = ![
    "completed",
    "complete",
    "done",
    "failed",
    "error",
    "cancelled",
  ].includes(latestStatus);

  let content = (
    <span className="computer-pip__idle">
      <Icon name="computer" size={22} />
    </span>
  );
  if (surface.mode === "browser") {
    content = hasFrame ? (
      <img className="computer-pip__browser-frame" src={state.frameUrl} alt="" draggable={false} />
    ) : (
      <Skeleton className="computer-pip__skeleton" width="100%" height="100%" label={t("computer.loading")} />
    );
  } else if (surface.mode === "file") {
    content = surface.file?.path || surface.file?.workspace_path ? (
      <FileComputerView scope={preview.scope} file={surface.file} compact />
    ) : (
      <Skeleton className="computer-pip__skeleton" width="100%" height="100%" label={t("computer.loading")} />
    );
  } else if (surface.mode === "search") {
    content = !surface.searchHits.length && surface.live && latestStepRunning ? (
      <Skeleton className="computer-pip__skeleton" width="100%" height="100%" label={t("computer.loading")} />
    ) : (
      <SearchComputerView hits={surface.searchHits} compact />
    );
  } else if (surface.mode === "present") {
    content = <PresentComputerView scope={preview.scope} present={surface.present} compact />;
  } else if (surface.mode === "terminal") {
    content = (
      <CompactTerminalPreview
        scope={preview.scope}
        fallbackStep={surface.latestStep}
      />
    );
  }

  return (
    <div className="computer-pip">
      <div className={cx(
        "computer-pip__player",
        surface.live && "is-live",
      )}>
        <div className="computer-pip__viewport" aria-hidden="true">
          {content}
        </div>
        <ComputerPipControl
          label={label}
          title={t("computer.title")}
          live={surface.live}
          runId={surface.runId}
          startedAt={surface.startedAt}
          modeLabel={modeLabel}
          activityLabel={activityLabel}
          onOpen={(opener) => preview.openComputer(undefined, opener)}
        />
      </div>
    </div>
  );
}
