import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, intlLocale } from "../../i18n";
import { cx } from "../../lib/cx";
import type { AgentPreviewScope, TerminalPreviewProcess } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";
import { PreviewStatus } from "./PreviewStatus";
import { useTerminalPreviews } from "./useTerminalPreviews";

function processOutput(process: TerminalPreviewProcess | null): string {
  if (!process) return "";
  return String(process.output || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function terminalProcessRunning(process: TerminalPreviewProcess): boolean {
  if (typeof process.running === "boolean") return process.running;
  return ![
    "complete",
    "completed",
    "exited",
    "finished",
    "failed",
    "closed",
    "cancelled",
    "canceled",
  ].includes(
    String(process.status || "").toLowerCase(),
  );
}

function previewTime(value: string | number | null | undefined, locale: string): string {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function terminalTitle(process: TerminalPreviewProcess, fallback: string): string {
  const title = String(process.title || "").trim();
  return title && !/^Terminal \d+$/i.test(title) ? title : fallback;
}

export function TerminalPreviewView({ scope }: { scope: AgentPreviewScope }) {
  const { t, locale } = useI18n();
  const { state, refresh } = useTerminalPreviews(scope);
  const [selectedProcessId, setSelectedProcessId] = useState("");
  const terminalRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const runningProcesses = useMemo(
    () => state.processes.filter(terminalProcessRunning),
    [state.processes],
  );

  const process = runningProcesses.find((item) => item.id === selectedProcessId)
    || runningProcesses[0]
    || null;
  const output = processOutput(process);

  useEffect(() => {
    if (process && process.id !== selectedProcessId) setSelectedProcessId(process.id);
    if (!process && selectedProcessId) setSelectedProcessId("");
  }, [process, selectedProcessId]);

  useEffect(() => {
    if (!terminalRef.current || !followOutput.current) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [output, process?.id]);

  const selectProcess = (id: string) => {
    followOutput.current = true;
    setSelectedProcessId(id);
  };
  const capturedAt = previewTime(process?.updated_at || state.capturedAt || state.checkedAt, intlLocale(locale));
  const idle = !state.loading && runningProcesses.length === 0;
  const selectedIndex = process ? Math.max(0, runningProcesses.indexOf(process)) : 0;

  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || [],
    );
    const currentIndex = tabs.indexOf(event.currentTarget);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex == null || !tabs[nextIndex]) return;
    event.preventDefault();
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  };

  return (
    <section className="terminal-preview" aria-label={t("terminalPreview.title")}>
      <header className="preview-toolbar">
        <div className="preview-toolbar__status">
          <PreviewStatus connection={state.connection} idle={idle} />
          <span className="status"><Icon name="shield" size={12} />{t("preview.readOnly")}</span>
          <span className="preview-updated">{t("terminalPreview.count", { count: runningProcesses.length })}</span>
          {capturedAt ? <span className="preview-updated">{t("preview.updatedAt", { time: capturedAt })}</span> : null}
        </div>
        <button className="btn btn--sm" type="button" onClick={refresh}>
          <Icon name="refresh" size={14} />
          <span>{t("preview.refresh")}</span>
        </button>
      </header>
      {state.error ? (
        <InlineAlert variant="warning">{state.error || t("preview.loadFailed")}</InlineAlert>
      ) : null}
      {process ? (
        <div className="terminal-preview__workspace">
          <div className="terminal-preview__tabs" role="tablist" aria-label={t("terminalPreview.title")}>
            {runningProcesses.map((item, index) => {
              const active = item.id === process.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`terminal-preview-tab-${index}`}
                  aria-controls="terminal-preview-panel"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={cx("terminal-preview__tab", active && "is-active")}
                  onClick={() => selectProcess(item.id)}
                  onKeyDown={moveTabFocus}
                >
                  <span className="dot dot--pulse" />
                  <span>{terminalTitle(item, t("terminalPreview.terminal", { number: index + 1 }))}</span>
                </button>
              );
            })}
          </div>
          <article
            className="terminal-preview__terminal"
            id="terminal-preview-panel"
            role="tabpanel"
            aria-labelledby={`terminal-preview-tab-${selectedIndex}`}
          >
            <header className="terminal-preview__head">
              <div>
                <strong>{terminalTitle(
                  process,
                  t("terminalPreview.terminal", { number: Math.max(1, runningProcesses.indexOf(process) + 1) }),
                )}</strong>
                <span className="terminal-preview__state is-running">{t("terminalPreview.running")}</span>
              </div>
              {process.truncated ? <span className="status status--warn">{t("terminalPreview.truncated")}</span> : null}
            </header>
            {process.cwd || process.command ? (
              <dl className="terminal-preview__facts">
                {process.cwd ? <><dt>{t("terminalPreview.cwd")}</dt><dd>{process.cwd}</dd></> : null}
                {process.command ? <><dt>{t("terminalPreview.command")}</dt><dd>{process.command}</dd></> : null}
              </dl>
            ) : null}
            <pre
              ref={terminalRef}
              className="terminal-preview__output"
              aria-label={t("terminalPreview.output")}
              tabIndex={0}
              onScroll={(event) => {
                const target = event.currentTarget;
                followOutput.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32;
              }}
            >{output || t("terminalPreview.emptyOutput")}</pre>
          </article>
        </div>
      ) : (
        <div className="preview-empty-card preview-empty-card--terminal">
          <EmptyState
            icon="terminal"
            title={state.loading ? t("preview.connecting") : t("terminalPreview.noTerminals")}
            text={t("terminalPreview.noTerminalsDetail")}
          />
        </div>
      )}
    </section>
  );
}
