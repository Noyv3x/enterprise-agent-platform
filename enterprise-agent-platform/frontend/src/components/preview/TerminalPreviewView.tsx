import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Tabs, Tag } from "antd";
import { useI18n, intlLocale, type MessageKey } from "../../i18n";
import type { ActivityStep, AgentPreviewScope, TerminalPreviewProcess } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";
import { Skeleton } from "../common/Skeleton";
import { PreviewStatus } from "./PreviewStatus";
import { useTerminalPreviews } from "./useTerminalPreviews";

const TERMINAL_TOOLS = new Set(["terminal", "process"]);
const EXIT_MARKER = /(?:^|\n)\[exit\s+(-?\d+|unknown)\][ \t]*$/i;
const COMPACT_OUTPUT_LINES = 5;
const COMPACT_OUTPUT_CHARS = 1_200;

const TERMINAL_STATUS_KEYS: Record<TerminalPreviewProcess["status"], MessageKey> = {
  running: "terminalPreview.running",
  orphaned: "terminalPreview.orphaned",
  completed: "chat.activity.state.completed",
  failed: "chat.activity.state.failed",
  cancelled: "scheduledTasks.run.cancelled",
};

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    : "";
}

function processOutput(process: TerminalPreviewProcess | null): string {
  return normalizedText(process?.output);
}

function resultWithExit(value: unknown): {
  output: string;
  exitCode?: number | null;
} {
  const result = normalizedText(value);
  const match = result.match(EXIT_MARKER);
  if (!match) return { output: result };
  const exitCode = match[1]?.toLowerCase() === "unknown"
    ? null
    : Number(match[1]);
  return {
    output: result.slice(0, match.index).replace(/\n+$/, ""),
    exitCode: exitCode != null && Number.isFinite(exitCode) ? exitCode : null,
  };
}

function stepStatus(
  step: ActivityStep,
  output: string,
  exitCode: number | null | undefined,
): TerminalPreviewProcess["status"] {
  const status = String(step.tool_status || "").trim().toLowerCase();
  if (/orphan/.test(status) || /^process state needs attention/i.test(output)) return "orphaned";
  if (/cancel/.test(status)) return "cancelled";
  if (/fail|error/.test(status)) return "failed";
  if (/running|started|pending/.test(status) || /^process started:/i.test(output)) return "running";
  if (exitCode != null && exitCode !== 0) return "failed";
  if (/complete|done|success/.test(status) || step.completed_at != null || output) return "completed";
  return "running";
}

/** Convert the bounded result retained in a work row into a terminal snapshot. */
export function terminalProcessFromStep(step: ActivityStep | null | undefined): TerminalPreviewProcess | null {
  const tool = String(step?.tool || step?.label || "").trim().toLowerCase();
  if (!step || !TERMINAL_TOOLS.has(tool)) return null;

  const command = normalizedText(
    step.parameters?.command ?? (tool === "terminal" ? step.detail : ""),
  ).trim();
  const cwd = normalizedText(step.parameters?.cwd).trim();
  const result = resultWithExit(step.result);
  const status = stepStatus(step, result.output, result.exitCode);
  const sequence = step.sequence ?? step.updated_sequence ?? "latest";
  const processId = tool === "process"
    ? String(step.parameters?.process_id || "").trim()
    : "";
  const identity = processId || step.tool_call_id || sequence;

  return {
    id: `work:${String(identity)}`,
    title: command.split("\n", 1)[0]?.slice(0, 200) || processId || undefined,
    command: command || undefined,
    cwd: cwd || undefined,
    output: result.output,
    status,
    running: status === "running" || status === "orphaned",
    started_at: step.at,
    updated_at: step.completed_at ?? step.at,
    finished_at: status === "running" || status === "orphaned"
      ? undefined
      : step.completed_at ?? step.at,
    ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
    truncated: Number(step.result_truncated_chars || 0) > 0,
  };
}

/** Merge the latest work row without letting an unrelated background process hide it. */
export function terminalDisplayProcesses(
  processes: TerminalPreviewProcess[],
  fallbackStep?: ActivityStep | null,
): TerminalPreviewProcess[] {
  const fallback = terminalProcessFromStep(fallbackStep);
  if (!fallback) return processes;
  const fallbackId = fallback.id.replace(/^work:/, "");
  const fallbackCommand = normalizedText(fallback.command).trim();
  const matchingIndex = processes.findIndex((process) => {
    const processId = String(process.id || "").replace(/^work:/, "");
    const processCommand = normalizedText(process.command).trim();
    return processId === fallbackId
      || Boolean(fallbackCommand && processCommand && processCommand === fallbackCommand);
  });
  if (matchingIndex < 0) return [fallback, ...processes];
  if (matchingIndex === 0) return processes;
  return [
    processes[matchingIndex]!,
    ...processes.slice(0, matchingIndex),
    ...processes.slice(matchingIndex + 1),
  ];
}

export function terminalProcessRunning(process: TerminalPreviewProcess): boolean {
  if (typeof process.running === "boolean") return process.running;
  return process.status === "running" || process.status === "orphaned";
}

function terminalProcessOrphaned(process: TerminalPreviewProcess): boolean {
  return process.status === "orphaned";
}

function terminalTranscript(process: TerminalPreviewProcess, emptyOutput = ""): string {
  const command = normalizedText(process.command).trim();
  const output = processOutput(process);
  const chunks: string[] = [];
  if (command) chunks.push(`$ ${command}`);
  if (output) chunks.push(output);
  else if (emptyOutput) chunks.push(emptyOutput);
  return chunks.join("\n");
}

export function compactTerminalTranscript(process: TerminalPreviewProcess): string {
  const rawCommand = normalizedText(process.command).trim();
  const command = rawCommand.length > 240 ? `${rawCommand.slice(0, 239)}…` : rawCommand;
  const output = processOutput(process).slice(-COMPACT_OUTPUT_CHARS);
  const outputLines = output.split("\n").slice(-COMPACT_OUTPUT_LINES).join("\n");
  return [command ? `$ ${command}` : "", outputLines].filter(Boolean).join("\n");
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
  const command = normalizedText(process.command).trim();
  const titleRepeatsCommand = Boolean(command && title && command.startsWith(title));
  if (title && !titleRepeatsCommand && !/^Terminal \d+$/i.test(title)) return title;
  const cwd = String(process.cwd || "").trim();
  return cwd ? `${fallback} · ${cwd}` : fallback;
}

function terminalStatusText(
  process: TerminalPreviewProcess,
  t: (key: MessageKey, variables?: Record<string, string | number>) => string,
): string {
  const status = t(TERMINAL_STATUS_KEYS[process.status]);
  if (process.exit_code === undefined) return status;
  return `${status} · exit ${process.exit_code ?? "?"}`;
}

function terminalStatusColor(process: TerminalPreviewProcess): string {
  if (process.status === "orphaned") return "hsl(38 92% 58%)";
  if (process.status === "failed") return "hsl(4 72% 62%)";
  if (process.status === "cancelled") return "hsl(220 8% 58%)";
  return "hsl(145 46% 62%)";
}

interface CompactTerminalPreviewProps {
  scope: AgentPreviewScope;
  fallbackStep?: ActivityStep | null;
}

/** Non-interactive terminal tail sized for the computer PiP. */
export function CompactTerminalPreview({ scope, fallbackStep }: CompactTerminalPreviewProps) {
  const { t } = useI18n();
  const { state } = useTerminalPreviews(scope);
  const process = terminalDisplayProcesses(state.processes, fallbackStep)[0] || null;
  if (!process) {
    return (
      <span
        className="terminal-preview-compact__loading"
        role="status"
        aria-label={t("computer.loading")}
      >
        <Skeleton
          className="computer-pip__skeleton"
          width="100%"
          height="100%"
          label={t("computer.loading")}
        />
      </span>
    );
  }

  return (
    <span className="terminal-preview-compact">
      <span className="terminal-preview-compact__status">
        <Badge color={terminalStatusColor(process)} />
        <span>{terminalStatusText(process, t)}</span>
      </span>
      <span
        className="terminal-preview-compact__output"
        aria-label={t("terminalPreview.output")}
      >
        {compactTerminalTranscript(process)
          || (terminalProcessRunning(process) ? t("terminalPreview.emptyOutput") : "")}
      </span>
    </span>
  );
}

interface TerminalPreviewViewProps {
  scope: AgentPreviewScope;
  fallbackStep?: ActivityStep | null;
}

export function TerminalPreviewView({ scope, fallbackStep }: TerminalPreviewViewProps) {
  const { t, locale } = useI18n();
  const { state, refresh } = useTerminalPreviews(scope);
  const [selectedProcessId, setSelectedProcessId] = useState("");
  const terminalRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const pinnedProcessId = useRef("");
  const processes = useMemo(
    () => terminalDisplayProcesses(state.processes, fallbackStep),
    [fallbackStep, state.processes],
  );

  const process = processes.find((item) => item.id === selectedProcessId)
    || processes[0]
    || null;
  const transcript = process
    ? terminalTranscript(
      process,
      terminalProcessRunning(process) ? t("terminalPreview.emptyOutput") : "",
    )
    : "";
  const orphaned = process ? terminalProcessOrphaned(process) : false;

  useEffect(() => {
    const nextPrimaryId = processes[0]?.id || "";
    const pinnedId = pinnedProcessId.current;
    const pinnedExists = Boolean(
      pinnedId && processes.some((item) => item.id === pinnedId),
    );
    if (pinnedExists) {
      if (selectedProcessId !== pinnedId) setSelectedProcessId(pinnedId);
      return;
    }
    if (pinnedId) pinnedProcessId.current = "";
    if (nextPrimaryId && selectedProcessId !== nextPrimaryId) {
      followOutput.current = true;
      setSelectedProcessId(nextPrimaryId);
    } else if (!nextPrimaryId) {
      if (selectedProcessId) setSelectedProcessId("");
    }
  }, [processes, selectedProcessId]);

  useEffect(() => {
    if (!terminalRef.current || !followOutput.current) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [transcript, process?.id]);

  const selectProcess = (id: string) => {
    pinnedProcessId.current = id;
    followOutput.current = true;
    setSelectedProcessId(id);
  };
  const capturedAt = previewTime(process?.updated_at || state.capturedAt || state.checkedAt, intlLocale(locale));
  const idle = !state.loading && processes.length === 0;
  const terminalPanel = process ? (
    <article
      className="terminal-preview__terminal"
      aria-label={terminalTitle(
        process,
        t("terminalPreview.terminal", { number: Math.max(1, processes.indexOf(process) + 1) }),
      )}
    >
      <header className="terminal-preview__head">
        <div>
          <strong>{terminalTitle(
            process,
            t("terminalPreview.terminal", { number: Math.max(1, processes.indexOf(process) + 1) }),
          )}</strong>
          <span className={`terminal-preview__state is-${process.status}`}>
            {terminalStatusText(process, t)}
          </span>
        </div>
        {process.truncated ? <Tag color="warning">{t("terminalPreview.truncated")}</Tag> : null}
      </header>
      {orphaned ? (
        <InlineAlert className="terminal-preview__orphaned" variant="warning">
          {t("terminalPreview.orphanedDetail")}
        </InlineAlert>
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
      >{transcript}</pre>
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
          <span className="preview-updated">{t("terminalPreview.count", { count: processes.length })}</span>
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
            items={processes.map((item, index) => ({
              key: item.id,
              label: (
                <span className="terminal-preview__tab-label">
                  <Badge color={terminalStatusColor(item)} />
                  <span className="terminal-preview__tab-title">{terminalTitle(item, t("terminalPreview.terminal", { number: index + 1 }))}</span>
                  {terminalProcessOrphaned(item) ? (
                    <span className="terminal-preview__tab-state">{t("terminalPreview.orphanedShort")}</span>
                  ) : null}
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
