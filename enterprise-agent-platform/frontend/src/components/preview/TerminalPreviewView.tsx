import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Tabs } from "antd";
import { useI18n, intlLocale, type MessageKey } from "../../i18n";
import type { ActivityStep, AgentPreviewScope, TerminalPreviewProcess } from "../../types";
import { ComputerOutput, EmptyState, LoadingState, Notice, StatusMark } from "../ui/fieldwork";
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

function terminalTone(process: TerminalPreviewProcess): "info" | "warning" | "danger" | "success" | "neutral" {
  if (process.status === "orphaned") return "warning";
  if (process.status === "failed") return "danger";
  if (process.status === "running") return "info";
  if (process.status === "completed") return "success";
  return "neutral";
}

interface CompactTerminalPreviewProps {
  scope: AgentPreviewScope;
  fallbackStep?: ActivityStep | null;
}

/** A single passive consumer of the authoritative terminal tail. */
export function CompactTerminalPreview({ scope, fallbackStep }: CompactTerminalPreviewProps) {
  const { t } = useI18n();
  const { state } = useTerminalPreviews(scope);
  const process = terminalDisplayProcesses(state.processes, fallbackStep)[0] || null;
  return (
    <div className="wf-terminal-compact">
      {process ? (
        <ComputerOutput
          kind="terminal"
          meta={<StatusMark tone={terminalTone(process)}>{terminalStatusText(process, t)}</StatusMark>}
          truncated={process.truncated ? t("terminalPreview.truncated") : undefined}
        >
          <pre aria-label={t("terminalPreview.output")}>
            {compactTerminalTranscript(process) || (terminalProcessRunning(process) ? t("terminalPreview.emptyOutput") : "")}
          </pre>
          {state.error ? <Notice tone="warning" title={state.error} /> : null}
        </ComputerOutput>
      ) : state.error ? (
        <Notice tone="warning" title={state.error} />
      ) : state.loading ? (
        <div role="status" aria-label={t("computer.loading")}><LoadingState label={t("computer.loading")} /></div>
      ) : (
        <EmptyState compact title={t("terminalPreview.noTerminals")} />
      )}
    </div>
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
  return (
    <section className="wf-terminal-reader" aria-label={t("terminalPreview.title")}>
      {processes.length > 1 ? (
        <Tabs
          activeKey={process?.id}
          animated={false}
          aria-label={t("terminalPreview.title")}
          onChange={selectProcess}
          items={processes.map((item, index) => ({
            key: item.id,
            label: terminalTitle(item, t("terminalPreview.terminal", { number: index + 1 })),
          }))}
        />
      ) : null}
      {state.error ? <Notice tone="warning" title={state.error} /> : null}
      {orphaned ? <Notice tone="warning" title={t("terminalPreview.orphanedDetail")} /> : null}
      {process ? (
        <div className="wf-terminal-canvas">
          <ComputerOutput
            kind="terminal"
            meta={<StatusMark tone={terminalTone(process)}>{terminalStatusText(process, t)}</StatusMark>}
            truncated={process.truncated ? t("terminalPreview.truncated") : undefined}
          >
            <pre
              ref={terminalRef}
              className="wf-terminal-transcript"
              aria-label={t("terminalPreview.output")}
              tabIndex={0}
              onScroll={(event) => {
                const target = event.currentTarget;
                followOutput.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32;
              }}
            >{transcript}</pre>
          </ComputerOutput>
        </div>
      ) : state.loading ? (
        <LoadingState label={t("preview.connecting")} />
      ) : !state.error ? (
        <EmptyState title={t("terminalPreview.noTerminals")} description={t("terminalPreview.noTerminalsDetail")} />
      ) : null}
      <footer className="wf-terminal-controls">
        <div className="wf-terminal-meta">
          <StatusMark>{t("preview.readOnly")}</StatusMark>
          <PreviewStatus connection={state.connection} idle={idle && !state.error} />
          <span>{t("terminalPreview.count", { count: processes.length })}</span>
          {capturedAt ? <span>{t("preview.updatedAt", { time: capturedAt })}</span> : null}
        </div>
        <Button onClick={refresh}>{t("preview.refresh")}</Button>
      </footer>
    </section>
  );
}
