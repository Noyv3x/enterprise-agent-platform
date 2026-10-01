/* Adapted from Beautiful UI components/primitives/CodeBlock.tsx (MIT, see ../NOTICE).
 * Adaptations: real code from the message instead of the demo file; the Diff view is parsed from a unified diff
 * (```diff fences) and keeps a Copy action next to its stat; the panel fills the reading column (`fill`); the
 * line-number gutter widens for 3+ digit listings; labels come from the caller (i18n). Markup and classes are
 * upstream's. Accessibility: text that upstream draws in ink-3 or a base hue (strings/numbers, diff stats, gutter
 * numbers, hunk headers, Copy) uses ink-2 or the matching *-ink token, so it keeps 4.5:1 on page and diff tints. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/* ─────────────────────────────────────────────────────────
 * CODE BLOCK
 * A light editor panel with two versions:
 *   · Code — a line-numbered listing
 *   · Diff — a unified diff: one gutter, a green/red accent
 *     bar and row tint.
 * Both share syntax coloring, insets, and wrapping behavior.
 * ───────────────────────────────────────────────────────── */

/* One row of a unified diff: its kind, its line number in the gutter, and its text. */
export type DiffRow = {
  num: number | null;
  type: "ctx" | "add" | "del" | "hunk";
  text: string;
};
/* Prominent copy strings on the code block. */
export type CodeBlockLabels = { copy: string; copied: string; copyCode: string };

const HATCH = "repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)";

/* light syntax coloring — keywords/imports/conditionals, functions, strings & numbers */
const KEYWORDS = new Set(["import", "from", "export", "default", "async", "function", "const", "let", "var", "await", "return", "if", "else", "for", "while", "new", "throw", "try", "catch", "null", "true", "false", "undefined"]);
const TOKEN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;

function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    const t = m[0];
    if (idx > last) nodes.push(<span key={k++}>{text.slice(last, idx)}</span>);
    let color: string;
    let weight: number | undefined;
    if (/^["'`]/.test(t) || /^\d/.test(t)) color = "var(--orange-ink)"; // string / number
    else if (KEYWORDS.has(t)) color = "var(--accent-ink)"; // keyword / import / conditional
    else { color = "var(--ink)"; weight = 500; } // function call
    nodes.push(<span key={k++} style={{ color, fontWeight: weight }}>{t}</span>);
    last = idx + t.length;
  }
  if (last < text.length) nodes.push(<span key={k++}>{text.slice(last)}</span>);
  return nodes;
}

/** Parses a unified diff into gutter rows; `---`/`+++` file headers name the file instead of rendering. */
export function parseUnifiedDiff(source: string): { rows: DiffRow[]; file: string | null } {
  const rows: DiffRow[] = [];
  let file: string | null = null;
  let oldLine = 1;
  let newLine = 1;
  for (const line of source.split("\n")) {
    if (/^(\+\+\+|---) /.test(line)) {
      const name = line.slice(4).trim().replace(/^[ab]\//, "");
      if (name !== "/dev/null" && line.startsWith("+++")) file = name;
      else if (name !== "/dev/null" && file === null) file = name;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ num: null, type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ num: newLine++, type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ num: oldLine++, type: "del", text: line.slice(1) });
    } else {
      rows.push({ num: newLine++, type: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
      oldLine++;
    }
  }
  return { rows, file };
}

function FileIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-3">
      <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
    </svg>
  );
}

export type CodeBlockProps = {
  /** Which view to render — "Code" (line-numbered listing) or "Diff". */
  variant?: "Code" | "Diff";
  /** The raw code (Code) or unified diff (Diff). */
  code: string;
  /** Filename or language shown in the header. */
  filename: string;
  labels: CodeBlockLabels;
  /** fill the parent width instead of the gallery's fixed measure */
  fill?: boolean;
};

export default function CodeBlock({ variant = "Code", code, filename, labels, fill = false }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const isDiff = variant === "Diff";
  const diff = isDiff ? parseUnifiedDiff(code) : null;
  const lines = code.split("\n");

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  const added = diff?.rows.filter((r) => r.type === "add").length ?? 0;
  const removed = diff?.rows.filter((r) => r.type === "del").length ?? 0;
  const digits = String(isDiff ? Math.max(0, ...(diff?.rows ?? []).map((r) => r.num ?? 0)) : lines.length).length;
  const gutter = Math.max(20, digits * 7 + 6);

  return (
    <div className={`w-full ${fill ? "" : "max-w-105"} overflow-hidden rounded-card bg-surface shadow-card`}>
      {/* header — file · (diff stat) · copy */}
      <div className="flex h-11 items-center gap-2 border-b border-line px-4 text-[12.5px]">
        <span className="inline-flex min-w-0 items-center gap-[7px]">
          <FileIcon />
          <span className="truncate font-mono leading-none text-ink">{diff?.file ?? filename}</span>
        </span>

        {isDiff && (
          <span className="ml-auto inline-flex items-center gap-2 font-mono text-[12px] leading-none tabular-nums">
            <span className="text-green-ink">+{added}</span>
            <span className="text-red-ink">-{removed}</span>
          </span>
        )}
        <button
          type="button"
          aria-label={copied ? labels.copied : labels.copyCode}
          onClick={copy}
          className={`-mr-1 ${isDiff ? "" : "ml-auto"} flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px]
            font-medium transition-colors duration-100 hover:bg-hover pointer-coarse:h-11 max-sm:h-11
            ${copied ? "text-green" : "text-ink-2 hover:text-ink"}`}
        >
          {copied ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {copied ? labels.copied : labels.copy}
        </button>
      </div>

      {/* body — equal 12px inset on top / left / right; lines wrap */}
      <div className="max-h-[480px] overflow-y-auto py-3 font-mono text-[12.5px] leading-[1.65] text-ink-2" tabIndex={0}>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 w-px bg-line" style={{ left: gutter }} />
          {diff
            ? diff.rows.map((r, i) => {
                const add = r.type === "add";
                const del = r.type === "del";
                return (
                  <div
                    key={i}
                    className={`relative grid items-start ${add ? "bg-green-tint" : del ? "bg-red-tint" : ""}`}
                    style={{ gridTemplateColumns: `${gutter}px minmax(0,1fr)` }}
                  >
                    {(add || del) && (
                      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: add ? "var(--green)" : HATCH }} />
                    )}
                    <span className={`select-none text-center text-[11px] ${add ? "text-green-ink" : del ? "text-red-ink" : "text-ink-2"}`}>{r.num ?? ""}</span>
                    <code className={`pr-3 pl-1 break-words whitespace-pre-wrap ${r.type === "hunk" ? "text-ink-2" : ""}`}>
                      {r.type === "hunk" ? r.text : highlight(r.text) }
                    </code>
                  </div>
                );
              })
            : lines.map((line, i) => (
                <div key={i} className="grid items-start" style={{ gridTemplateColumns: `${gutter}px minmax(0,1fr)` }}>
                  <span className="select-none text-center text-[11px] text-ink-2">{i + 1}</span>
                  <code className="pr-3 pl-1 break-words whitespace-pre-wrap">{line ? highlight(line) : "\u200b"}</code>
                </div>
              ))}
        </div>
      </div>
    </div>
  );
}
