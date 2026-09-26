import { Badge, Button, Tooltip } from 'antd';
import { useId } from 'react';
import type { ReactNode, Ref, UIEventHandler } from 'react';
import { Button as BuiButton } from '../beautiful/Button';
import { Glyph } from './Fieldwork';

export interface ConversationLayoutProps {
  header: ReactNode;
  children: ReactNode;
  composer: ReactNode;
  /** Controls floated above the composer without taking flow height; only the controls themselves receive input. */
  floatingActions?: ReactNode;
  companion?: ReactNode;
  notice?: ReactNode;
  threadRef?: Ref<HTMLDivElement>;
  onThreadScroll?: UIEventHandler<HTMLDivElement>;
  threadLabel: string;
}
/** The controller owns history anchors, unread state, focus, and all real-time subscriptions. */
export function ConversationLayout({ header, children, composer, floatingActions, companion, notice, threadRef, onThreadScroll, threadLabel }: ConversationLayoutProps) {
  return <div className={`wf-conversation${companion ? ' wf-conversation--with-companion' : ''}`}><div className="wf-conversation-header">{header}</div>{notice && <div className="wf-conversation-notice">{notice}</div>}<div className="wf-conversation-body"><div className="wf-conversation-column"><div className="wf-thread" ref={threadRef} onScroll={onThreadScroll} role="log" aria-label={threadLabel} aria-live="off" tabIndex={0}><div className="wf-thread-inner">{children}</div></div><div className="wf-composer-dock">{floatingActions && <div className="wf-composer-rail">{floatingActions}</div>}{composer}</div></div>{companion && <aside className="wf-companion">{companion}</aside>}</div></div>;
}

export interface ConversationJumpProps { label: string; count?: number; onClick: () => void }
/** Compact control for returning to the latest message; the controller owns unread counting. */
export function ConversationJump({ label, count = 0, onClick }: ConversationJumpProps) {
  return <Tooltip title={label}><Badge count={count} overflowCount={99} size="small"><Button className="wf-latest-action" aria-label={label} icon={<Glyph name="arrow" className="wf-rotate" />} onClick={onClick} /></Badge></Tooltip>;
}

export interface DraftSuggestion { key: string; label: ReactNode; description?: ReactNode; onSelect: () => void }
export interface ConversationEmptyProps { title: ReactNode; description?: ReactNode }
export function ConversationEmpty({ title, description }: ConversationEmptyProps) {
  return (
    <section className="wf-conversation-empty">
      <h2>{title}</h2>
      {description && <div className="wf-conversation-empty-description">{description}</div>}
    </section>
  );
}

export interface MessageEntryProps { kind: 'user' | 'agent' | 'system'; header?: ReactNode; footnote?: ReactNode; actions?: ReactNode; children: ReactNode; attachments?: ReactNode; work?: ReactNode; label?: string; streaming?: boolean }
/**
 * `header` carries only what must precede the content (author, attention marks) and is omitted when empty.
 * `footnote` (time or live progress) and `actions` share one footer row that exists in every state, so a
 * live message, its settling copy and the persisted record keep the same geometry.
 * `streaming` only adds a caret after the last received characters; it never fabricates text or motion beyond that mark.
 */
export function MessageEntry({ kind, header, footnote, actions, children, attachments, work, label, streaming = false }: MessageEntryProps) {
  return <article className={`wf-message wf-message--${kind}${streaming ? ' wf-message--streaming' : ''}`} aria-label={label}>{header && <header className="wf-message-meta">{header}</header>}{work && <div className="wf-message-work">{work}</div>}<div className="wf-message-content"><div className="wf-message-body">{children}</div>{attachments && <div className="wf-message-attachments">{attachments}</div>}</div>{(footnote || actions) && <footer className="wf-message-footer">{footnote && <span className="wf-message-footnote">{footnote}</span>}{actions && <span className="wf-message-actions">{actions}</span>}</footer>}</article>;
}
export interface AttachmentSlotProps { name: ReactNode; meta?: ReactNode; preview?: ReactNode; actions?: ReactNode; status?: ReactNode }
export function AttachmentSlot({ name, meta, preview, actions, status }: AttachmentSlotProps) {
  return <div className="wf-attachment">{preview && <div className="wf-attachment-preview">{preview}</div>}<div className="wf-attachment-info"><Glyph name="file" /><div className="wf-attachment-copy"><strong>{name}</strong>{meta && <span className="wf-attachment-meta">{meta}</span>}{status}</div>{actions && <div className="wf-attachment-actions">{actions}</div>}</div></div>;
}

export interface ComposerFrameProps { input: ReactNode; attachments?: ReactNode; suggestions?: ReactNode; startActions?: ReactNode; submitAction: ReactNode; hint?: ReactNode; status?: ReactNode; recovery?: ReactNode; disabled?: boolean; label: string }
/**
 * Beautiful UI Prompt Bar (primitives/PromptBar.tsx, "tall" rounded layout): a raised card whose hairline deepens on
 * focus, attachments as chips above a full-width input, and a quiet control row (add · status · usage · send).
 * Menus grow up from the bar's top edge. Input is controller-owned (native textarea with IME/mention handlers).
 */
export function ComposerFrame({ input, attachments, suggestions, startActions, submitAction, hint, status, recovery, disabled = false, label }: ComposerFrameProps) {
  return <section className="relative min-w-0" aria-label={label}>
    {recovery && <div className="mb-2 max-h-40 overflow-auto">{recovery}</div>}
    {suggestions && <div className="absolute inset-x-0 bottom-full z-10 mb-2">{suggestions}</div>}
    <div className={`wf-composer-frame relative isolate flex flex-col gap-2 overflow-hidden rounded-[18px] border p-2.5 transition-[border-color,box-shadow,background-color] duration-150 ${disabled
      ? 'border-line bg-inset'
      : 'border-line bg-surface shadow-card focus-within:border-line-strong focus-within:shadow-raised'}`}>
      {attachments && <div className="max-h-32 overflow-auto px-0.5 pt-0.5">{attachments}</div>}
      <div className="px-1.5 pt-0.5">{input}</div>
      <div className="flex min-w-0 items-center gap-1">
        <div className="flex shrink-0 items-center gap-1">{startActions}</div>
        {status && <div className="min-w-0 truncate text-[12px] text-ink-3" role="status">{status}</div>}
        <div className="ml-auto flex shrink-0 items-center gap-1">{submitAction}</div>
      </div>
    </div>
    {/* Keyboard shortcuts mean nothing on touch keyboards; the row disappears there. */}
    {hint && <div className="mt-1.5 flex flex-wrap justify-between gap-3 px-2 text-[11.5px] text-ink-3 pointer-coarse:hidden max-[800px]:hidden">{hint}</div>}
  </section>;
}

export interface ApprovalChoice { key: string; label: ReactNode; danger?: boolean; primary?: boolean; onChoose: () => void }
export interface ApprovalPanelProps { title: ReactNode; description?: ReactNode; detail?: ReactNode; choices: ApprovalChoice[]; busy?: boolean; status?: ReactNode; subject?: ReactNode }
/**
 * Beautiful UI Approval Card (primitives/ApprovalCard.tsx): the request is the heading, the exact command sits on a
 * field chip, and the footer carries status on the left and pill decisions on the right (accent = the primary one).
 */
export function ApprovalPanel({ title, description, detail, choices, busy = false, status, subject }: ApprovalPanelProps) {
  const headingId = useId();
  return <section className="bui-edge my-4 w-full max-w-[35rem] overflow-hidden rounded-card bg-surface shadow-card" aria-labelledby={headingId} aria-busy={busy}
    style={{ animation: 'fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}>
    <div className="primitive-card-pad">
      <header className="flex items-start gap-2">
        <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-orange-tint text-orange" aria-hidden="true"><Glyph name="lock" size={12} /></span>
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="m-0 text-[14px] leading-5 font-medium text-ink">{title}</h3>
          {subject && <div className="mt-0.5 text-[12px] text-ink-3">{subject}</div>}
        </div>
      </header>
      {description && <div className="mt-1.5 pl-7 text-[13px] leading-[1.6] text-ink-2">{description}</div>}
      {detail && <div className="mt-2.5 pl-7 [&_pre]:m-0 [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:rounded-control [&_pre]:bg-field [&_pre]:px-2.5 [&_pre]:py-2 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-[1.6] [&_pre]:text-ink [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_pre]:shadow-hairline">{detail}</div>}
    </div>
    <div className="primitive-card-footer flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line-soft">
      <div className="min-w-0 pl-1 text-[12px] font-medium text-ink-3">{status}</div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {choices.map((choice) => <BuiButton key={choice.key} type="button" size="sm" variant={choice.primary ? 'accent' : choice.danger ? 'ghost' : 'secondary'}
          className={choice.danger ? 'text-red' : undefined} disabled={busy} onClick={choice.onChoose}>{choice.label}</BuiButton>)}
      </div>
    </div>
  </section>;
}

export interface ContextUsageProps { label: string; usedLabel: string; limitLabel: string; used: string; max: string; percent: number; details?: ReactNode }
/** Context usage: a hairline meter with mono tabular figures (Beautiful UI value styling). */
export function ContextUsage({ label, usedLabel, limitLabel, used, max, percent, details }: ContextUsageProps) {
  const boundedPercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return <section className="min-w-0 pt-3">
    <div className="mb-2 flex items-baseline justify-between gap-3 text-[12.5px]"><strong className="font-medium text-ink">{label}</strong><span className="font-mono text-[12px] text-ink-2 tabular-nums">{percent}%</span></div>
    <div className="h-1.5 overflow-hidden rounded-full bg-field shadow-hairline forced-colors:outline forced-colors:outline-1" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={boundedPercent} aria-valuetext={`${usedLabel}: ${used}; ${limitLabel}: ${max}`}>
      <span className="block h-full rounded-full bg-accent forced-colors:bg-[CanvasText]" style={{ width: `${boundedPercent}%` }} />
    </div>
    <dl className="m-0 mt-3 flex flex-wrap gap-6">
      <div><dt className="text-[11.5px] text-ink-3">{usedLabel}</dt><dd className="m-0 mt-0.5 font-mono text-[12.5px] text-ink tabular-nums">{used}</dd></div>
      <div><dt className="text-[11.5px] text-ink-3">{limitLabel}</dt><dd className="m-0 mt-0.5 font-mono text-[12.5px] text-ink tabular-nums">{max}</dd></div>
    </dl>
    {details && <div className="mt-3 text-[12px] text-ink-3">{details}</div>}
  </section>;
}

export interface ComputerPanelProps { title: ReactNode; modeLabel: ReactNode; status?: ReactNode; elapsed?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; expanded?: boolean }
/** Mount for started work or retained resources; expansion unmounts the compact consumer. */
export function ComputerPanel({ title, modeLabel, status, elapsed, actions, children, footer, expanded = false }: ComputerPanelProps) {
  return <section className={`wf-computer${expanded ? ' wf-computer--expanded' : ''}`}><header className="wf-computer-header"><div className="wf-computer-heading"><h2>{title}</h2><div className="wf-computer-meta"><span>{modeLabel}</span>{status}{elapsed && <span className="wf-mono">{elapsed}</span>}</div></div>{actions && <div className="wf-actions">{actions}</div>}</header><div className="wf-computer-content">{children}</div>{footer && <footer className="wf-computer-footer">{footer}</footer>}</section>;
}
export interface ComputerOutputProps { kind: 'file' | 'terminal' | 'search'; title?: ReactNode; meta?: ReactNode; children: ReactNode; truncated?: ReactNode }
export function ComputerOutput({ kind, title, meta, children, truncated }: ComputerOutputProps) {
  return <div className={`wf-output wf-output--${kind}`}>{(title || meta) && <header className="wf-output-header">{title && <strong>{title}</strong>}{meta && <span>{meta}</span>}</header>}<div className="wf-output-body" tabIndex={0}>{children}</div>{truncated && <div className="wf-output-truncated" role="status">{truncated}</div>}</div>;
}
export function BrowserControlBar({ status, description, action, danger = false }: { status: ReactNode; description?: ReactNode; action?: ReactNode; danger?: boolean }) {
  return <div className={`wf-browser-control${danger ? ' wf-browser-control--warning' : ''}`}><div><strong role="status">{status}</strong>{description && <div>{description}</div>}</div>{action && <div className="wf-actions">{action}</div>}</div>;
}

export function CapabilityHeader({ title, description, scope, actions }: { title: ReactNode; description?: ReactNode; scope?: ReactNode; actions?: ReactNode }) {
  return <header className="wf-capability-header"><div>{scope && <div className="wf-eyebrow">{scope}</div>}<h2>{title}</h2>{description && <div className="wf-capability-description">{description}</div>}</div>{actions && <div className="wf-actions">{actions}</div>}</header>;
}
export function SearchToolbar({ search }: { search: ReactNode }) {
  return (
    <div className="wf-search-toolbar">
      <div className="wf-search-input">{search}</div>
    </div>
  );
}
export interface GuideSheetProps { title: ReactNode; intro: ReactNode; sections: { key: string; title: ReactNode; body: ReactNode }[]; examples?: DraftSuggestion[]; action?: ReactNode; notice?: ReactNode }
export function GuideSheet({ title, intro, sections, examples, action, notice }: GuideSheetProps) {
  return (
    <div className="wf-guide">
      <header>
        <h2>{title}</h2>
        <div className="wf-guide-intro">{intro}</div>
      </header>
      <ol className="wf-guide-sections">
        {sections.map((section, index) => (
          <li key={section.key}>
            <span className="wf-guide-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <h3>{section.title}</h3>
              <div>{section.body}</div>
            </div>
          </li>
        ))}
      </ol>
      {examples && examples.length > 0 && (
        <ul className="wf-suggestions">
          {examples.map((item) => (
            <li key={item.key}>
              <Button type="text" className="wf-suggestion" onClick={item.onSelect}>
                <span>
                  <strong>{item.label}</strong>
                  {item.description && <span className="wf-suggestion-description">{item.description}</span>}
                </span>
                <Glyph name="arrow" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {notice}
      {action && <div className="wf-guide-action">{action}</div>}
    </div>
  );
}
