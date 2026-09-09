import { Button } from 'antd';
import { useId, useState } from 'react';
import type { ReactNode, Ref, UIEventHandler } from 'react';
import { Glyph } from './Fieldwork';

export interface ConversationLayoutProps {
  header: ReactNode;
  children: ReactNode;
  composer: ReactNode;
  companion?: ReactNode;
  notice?: ReactNode;
  threadRef?: Ref<HTMLDivElement>;
  onThreadScroll?: UIEventHandler<HTMLDivElement>;
  threadLabel: string;
}
/** The controller owns history anchors, unread state, focus, and all real-time subscriptions. */
export function ConversationLayout({ header, children, composer, companion, notice, threadRef, onThreadScroll, threadLabel }: ConversationLayoutProps) {
  return <div className={`wf-conversation${companion ? ' wf-conversation--with-companion' : ''}`}><div className="wf-conversation-header">{header}</div>{notice && <div className="wf-conversation-notice">{notice}</div>}<div className="wf-conversation-body"><div className="wf-conversation-column"><div className="wf-thread" ref={threadRef} onScroll={onThreadScroll} role="log" aria-label={threadLabel} aria-live="off" tabIndex={0}><div className="wf-thread-inner">{children}</div></div><div className="wf-composer-dock">{composer}</div></div>{companion && <aside className="wf-companion">{companion}</aside>}</div></div>;
}

export interface DraftSuggestion { key: string; label: ReactNode; description?: ReactNode; onSelect: () => void }
export interface ConversationEmptyProps { title: ReactNode; description?: ReactNode; suggestions?: DraftSuggestion[]; footer?: ReactNode }
export function ConversationEmpty({ title, description, suggestions, footer }: ConversationEmptyProps) {
  return <section className="wf-conversation-empty"><h2>{title}</h2>{description && <div className="wf-conversation-empty-description">{description}</div>}{suggestions && suggestions.length > 0 && <ul className="wf-suggestions">{suggestions.map((suggestion) => <li key={suggestion.key}><Button type="text" className="wf-suggestion" onClick={suggestion.onSelect}><span><strong>{suggestion.label}</strong>{suggestion.description && <span className="wf-suggestion-description">{suggestion.description}</span>}</span><Glyph name="arrow" /></Button></li>)}</ul>}{footer && <div className="wf-conversation-empty-footer">{footer}</div>}</section>;
}

export interface MessageEntryProps { kind: 'user' | 'agent' | 'system'; author?: ReactNode; timestamp?: ReactNode; status?: ReactNode; actions?: ReactNode; children: ReactNode; attachments?: ReactNode; work?: ReactNode; label?: string }
export function MessageEntry({ kind, author, timestamp, status, actions, children, attachments, work, label }: MessageEntryProps) {
  return <article className={`wf-message wf-message--${kind}`} aria-label={label}>{(author || timestamp || status) && <header className="wf-message-meta">{author && <strong className="wf-message-author">{author}</strong>}{timestamp && <span className="wf-message-time">{timestamp}</span>}{status}</header>}{work && <div className="wf-message-work">{work}</div>}<div className="wf-message-body">{children}</div>{attachments && <div className="wf-message-attachments">{attachments}</div>}{actions && <footer className="wf-message-actions">{actions}</footer>}</article>;
}
export interface AttachmentSlotProps { name: ReactNode; meta?: ReactNode; preview?: ReactNode; actions?: ReactNode; status?: ReactNode }
export function AttachmentSlot({ name, meta, preview, actions, status }: AttachmentSlotProps) {
  return <div className="wf-attachment">{preview && <div className="wf-attachment-preview">{preview}</div>}<div className="wf-attachment-info"><Glyph name="file" /><div className="wf-attachment-copy"><strong>{name}</strong>{meta && <span className="wf-attachment-meta">{meta}</span>}{status}</div>{actions && <div className="wf-attachment-actions">{actions}</div>}</div></div>;
}

export interface ComposerFrameProps { input: ReactNode; attachments?: ReactNode; suggestions?: ReactNode; startActions?: ReactNode; submitAction: ReactNode; hint?: ReactNode; status?: ReactNode; recovery?: ReactNode; disabled?: boolean; label: string }
/** Input is controller-owned: native textarea or Ant TextArea, with existing IME/mention handlers. */
export function ComposerFrame({ input, attachments, suggestions, startActions, submitAction, hint, status, recovery, disabled = false, label }: ComposerFrameProps) {
  return <section className={`wf-composer-area${disabled ? ' wf-composer-area--disabled' : ''}`} aria-label={label}>{recovery && <div className="wf-composer-recovery">{recovery}</div>}{suggestions && <div className="wf-composer-suggestions">{suggestions}</div>}<div className="wf-composer-frame">{attachments && <div className="wf-composer-attachments">{attachments}</div>}<div className="wf-composer-input-wrap">{input}</div><div className="wf-composer-toolbar"><div className="wf-composer-start">{startActions}</div>{status && <div className="wf-composer-status" role="status">{status}</div>}<div className="wf-composer-submit">{submitAction}</div></div></div>{hint && <div className="wf-composer-hint">{hint}</div>}</section>;
}

export interface WorkRecordProps { title: ReactNode; status?: ReactNode; active: boolean; expanded?: boolean; onExpandedChange?: (expanded: boolean) => void; children: ReactNode }
export function WorkRecord({ title, status, active, expanded, onExpandedChange, children }: WorkRecordProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const bodyId = useId();
  const open = active || (expanded ?? localExpanded);
  const toggle = () => {
    const next = !open;
    if (expanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };
  return <section className={`wf-work${active ? ' wf-work--active' : ''}`}><div className="wf-work-heading">{active ? <div className="wf-work-label"><Glyph name="terminal" /><strong>{title}</strong></div> : <Button type="text" className="wf-work-toggle" onClick={toggle} aria-expanded={open} aria-controls={bodyId}><Glyph name="chevron" className={open ? 'wf-rotate' : undefined} size={16} /><span>{title}</span></Button>}{status}</div><div id={bodyId} className="wf-work-body" hidden={!open}>{children}</div></section>;
}
export interface WorkStepProps { title: ReactNode; meta?: ReactNode; status?: ReactNode; children?: ReactNode; expanded?: boolean; onExpandedChange?: (expanded: boolean) => void }
export function WorkStep({ title, meta, status, children, expanded, onExpandedChange }: WorkStepProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const bodyId = useId();
  const open = expanded ?? localExpanded;
  const hasDetail = Boolean(children);
  return <div className="wf-work-step"><div className="wf-work-step-heading">{hasDetail ? <Button type="text" className="wf-work-step-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => { if (expanded === undefined) setLocalExpanded(!open); onExpandedChange?.(!open); }}><Glyph name="chevron" className={open ? 'wf-rotate' : undefined} size={16} /><span>{title}</span></Button> : <strong className="wf-work-step-title">{title}</strong>}{status}{meta && <span className="wf-work-step-meta">{meta}</span>}</div>{hasDetail && <div id={bodyId} className="wf-work-step-detail" hidden={!open}>{children}</div>}</div>;
}

export interface ApprovalChoice { key: string; label: ReactNode; danger?: boolean; onChoose: () => void }
export interface ApprovalPanelProps { title: ReactNode; description?: ReactNode; detail?: ReactNode; choices: ApprovalChoice[]; busy?: boolean; status?: ReactNode }
export function ApprovalPanel({ title, description, detail, choices, busy = false, status }: ApprovalPanelProps) {
  const headingId = useId();
  return <section className="wf-approval" aria-labelledby={headingId} aria-busy={busy}><header><Glyph name="lock" /><h3 id={headingId}>{title}</h3>{status}</header>{description && <div className="wf-approval-description">{description}</div>}{detail && <div className="wf-approval-detail">{detail}</div>}<div className="wf-actions">{choices.map((choice) => <Button key={choice.key} danger={choice.danger} disabled={busy} onClick={choice.onChoose}>{choice.label}</Button>)}</div></section>;
}

export interface ContextUsageProps { label: string; usedLabel: string; limitLabel: string; used: number; max: number; percent: number; details?: ReactNode }
export function ContextUsage({ label, usedLabel, limitLabel, used, max, percent, details }: ContextUsageProps) {
  const boundedPercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return <section className="wf-context"><div className="wf-context-heading"><strong>{label}</strong><span className="wf-mono">{percent}%</span></div><div className="wf-context-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={boundedPercent} aria-valuetext={`${usedLabel}: ${used}; ${limitLabel}: ${max}`}><span style={{ width: `${boundedPercent}%` }} /></div><dl className="wf-context-values"><div><dt>{usedLabel}</dt><dd>{used}</dd></div><div><dt>{limitLabel}</dt><dd>{max}</dd></div></dl>{details && <div className="wf-context-details">{details}</div>}</section>;
}

export interface ComputerPanelProps { title: ReactNode; modeLabel: ReactNode; status?: ReactNode; elapsed?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; expanded?: boolean }
/** Mount only when a real work clue/resource exists; expanded controller unmounts compact consumer. */
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
export function SearchToolbar({ search, filters, actions }: { search: ReactNode; filters?: ReactNode; actions?: ReactNode }) {
  return <div className="wf-search-toolbar"><div className="wf-search-input">{search}</div>{filters && <div className="wf-search-filters">{filters}</div>}{actions && <div className="wf-actions">{actions}</div>}</div>;
}
export interface GuideSheetProps { title: ReactNode; intro: ReactNode; sections: { key: string; title: ReactNode; body: ReactNode }[]; example?: ReactNode; examples?: DraftSuggestion[]; action?: ReactNode; notice?: ReactNode }
export function GuideSheet({ title, intro, sections, example, examples, action, notice }: GuideSheetProps) {
  return <div className="wf-guide"><header><h2>{title}</h2><div className="wf-guide-intro">{intro}</div></header><ol className="wf-guide-sections">{sections.map((section, index) => <li key={section.key}><span className="wf-guide-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div><h3>{section.title}</h3><div>{section.body}</div></div></li>)}</ol>{example && <div className="wf-guide-example">{example}</div>}{examples && examples.length > 0 && <ul className="wf-suggestions">{examples.map((item) => <li key={item.key}><Button type="text" className="wf-suggestion" onClick={item.onSelect}><span><strong>{item.label}</strong>{item.description && <span className="wf-suggestion-description">{item.description}</span>}</span><Glyph name="arrow" /></Button></li>)}</ul>}{notice}{action && <div className="wf-guide-action">{action}</div>}</div>;
}
