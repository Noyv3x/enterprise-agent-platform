import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Tabs, Tag } from "antd";
import { useI18n, intlLocale } from "../../i18n";
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
  const terminalPanel = process ? (
    <article
      className="terminal-preview__terminal"
      aria-label={terminalTitle(
        process,
        t("terminalPreview.terminal", { number: Math.max(1, runningProcesses.indexOf(process) + 1) }),
      )}
    >
      <header className="terminal-preview__head">
        <div>
          <strong>{terminalTitle(
            process,
            t("terminalPreview.terminal", { number: Math.max(1, runningProcesses.indexOf(process) + 1) }),
          )}</strong>
          <span className="terminal-preview__state is-running">{t("terminalPreview.running")}</span>
        </div>
        {process.truncated ? <Tag color="warning">{t("terminalPreview.truncated")}</Tag> : null}
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
  ) : null;

  return (
    <section className="terminal-preview" aria-label={t("terminalPreview.title")}>
      <header className="preview-toolbar">
        <div className="preview-toolbar__status">
          <PreviewStatus connection={state.connection} idle={idle} />
          <Tag className="preview-readonly" icon={<Icon name="shield" size={12} />}>
            {t("preview.readOnly")}
          </Tag>
          <span className="preview-updated">{t("terminalPreview.count", { count: runningProcesses.length })}</span>
          {capturedAt ? <span className="preview-updated">{t("preview.updatedAt", { time: capturedAt })}</span> : null}
        </div>
        <Button className="preview-toolbar__action" size="small" icon={<Icon name="refresh" size={14} />} onClick={refresh}>
          <span>{t("preview.refresh")}</span>
        </Button>
      </header>
      {state.error ? (
        <InlineAlert variant="warning">{state.error || t("preview.loadFailed")}</InlineAlert>
      ) : null}
      {process ? (
        <div className="terminal-preview__workspace">
          <Tabs
            className="terminal-preview__tabs"
            classNames={{
              header: "terminal-preview__tabs-header",
              item: "terminal-preview__tabs-item",
              indicator: "terminal-preview__tabs-indicator",
              body: "terminal-preview__tabs-body",
              content: "terminal-preview__tabs-content",
            }}
            activeKey={process.id}
            animated={false}
            tabBarGutter={3}
            aria-label={t("terminalPreview.title")}
            onChange={selectProcess}
            items={runningProcesses.map((item, index) => ({
              key: item.id,
              label: (
                <span className="terminal-preview__tab-label">
                  <Badge color="hsl(145 46% 62%)" />
                  <span>{terminalTitle(item, t("terminalPreview.terminal", { number: index + 1 }))}</span>
                </span>
              ),
              children: item.id === process.id ? terminalPanel : null,
            }))}
          />
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
