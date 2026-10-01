/* Adapted from Beautiful UI components/primitives/FineTuneCard.tsx (MIT, see ../LICENSE and ../NOTICE).
 * Adaptations: the demo flavor-card inspector becomes a composable inspector — the card shell keeps the
 * upstream header (title + "Edited" check), `primitive-card-pad` sections with their 12.5px label, and the
 * `primitive-card-footer` row; the ScrubField chrome (field fill, chip radius, inline label, accent ring
 * when changed) carries text and colour inputs instead of scrubbed numbers; the "Adjust" shimmer is a static
 * accent label because nothing is running; the demo layout segments, number fields and type menu are
 * dropped; labels come from the caller's i18n; the width follows `className`; fields grow to 44px on touch. */
import { useId, type ReactNode } from "react";
import "./fine-tune-card.css";

export type FineTuneStatus = "idle" | "edited" | "saved";

export function FineTuneSection({ label, children, last = false }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={`primitive-card-pad flex flex-col gap-2 ${last ? "" : "border-b border-line"}`}>
      <p className="text-[12.5px] font-medium text-ink">{label}</p>
      {children}
    </div>
  );
}

function FieldShell({ active, invalid, children }: { active: boolean; invalid?: boolean; children: ReactNode }) {
  return (
    <label
      className="fine-tune-field flex h-6.5 min-w-0 items-center gap-1 rounded-chip py-1 pr-1 pl-0.5
        transition-[background-color,box-shadow] duration-200 touch:h-11"
      style={{
        background: invalid ? "var(--red-tint)" : active ? "var(--accent-tint)" : "var(--field)",
        boxShadow: invalid ? "0 0 0 1px var(--red)" : active ? "0 0 0 1px var(--accent)" : "none",
      }}
    >
      {children}
    </label>
  );
}

/** A text property in the ScrubField chrome: inline label, then the value. */
export function FineTuneTextField({ label, value, onChange, changed, invalid, hint, maxLength }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  changed: boolean;
  invalid?: boolean;
  hint?: string;
  maxLength?: number;
}) {
  const hintId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldShell active={changed} invalid={invalid}>
        <span className="flex h-full shrink-0 items-center rounded-[4px] px-0.5 text-[12px] text-ink-2 select-none">{label}</span>
        <input
          value={value}
          maxLength={maxLength}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none"
        />
      </FieldShell>
      {hint && <span id={hintId} className={`px-0.5 text-[11.5px] ${invalid ? "text-red-ink" : "text-ink-2"}`}>{hint}</span>}
    </div>
  );
}

/** A colour property: a swatch that opens the system picker, plus the hex value. */
export function FineTuneColorField({ label, value, onChange, changed, invalid, hint, swatchLabel }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  changed: boolean;
  invalid?: boolean;
  hint?: string;
  swatchLabel: string;
}) {
  const hintId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="fine-tune-swatch relative size-6.5 shrink-0 overflow-hidden rounded-chip shadow-hairline" style={{ background: invalid ? "var(--field)" : value }}>
          <input
            type="color"
            aria-label={swatchLabel}
            value={invalid ? "#000000" : value}
            onChange={(event) => onChange(event.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </span>
        <div className="min-w-0 flex-1">
          <FieldShell active={changed} invalid={invalid}>
            <span className="flex h-full shrink-0 items-center rounded-[4px] px-0.5 text-[12px] text-ink-2 select-none">{label}</span>
            <input
              value={value}
              maxLength={7}
              spellCheck={false}
              aria-invalid={invalid || undefined}
              aria-describedby={hint ? hintId : undefined}
              onChange={(event) => onChange(event.target.value)}
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink tabular-nums outline-none"
            />
          </FieldShell>
        </div>
      </div>
      {hint && <span id={hintId} className={`px-0.5 text-[11.5px] ${invalid ? "text-red-ink" : "text-ink-2"}`}>{hint}</span>}
    </div>
  );
}

export type FineTuneCardLabels = {
  title: string;
  edited: string;
  saved: string;
};

export default function FineTuneCard({
  labels,
  status,
  children,
  footer,
  className = "max-w-60",
}: {
  labels: FineTuneCardLabels;
  status: FineTuneStatus;
  /** FineTuneSection blocks */
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative w-full rounded-card bg-surface shadow-raised ${className}`}>
      {/* header */}
      <div className="primitive-card-bar flex items-center justify-between border-b border-line" aria-live="polite">
        <span className="text-[13px] font-medium text-ink">{labels.title}</span>
        {status === "saved" ? (
          <span
            className="flex items-center gap-1.5 text-[12px] font-medium text-green-ink"
            style={{ animation: "pop-in 250ms cubic-bezier(0.23,1,0.32,1) both" }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6L9 17l-5-5" />
            </svg>
            {labels.saved}
          </span>
        ) : status === "edited" ? (
          <span className="flex items-center gap-1.5">
            <span className="flex size-4.5 items-center justify-center rounded-[5px] border border-accent/30 bg-accent-tint" aria-hidden>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="var(--accent)">
                <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
              </svg>
            </span>
            <span className="text-[12px] font-medium text-accent-ink">{labels.edited}</span>
          </span>
        ) : null}
      </div>

      {children}

      {/* interaction section */}
      {footer && <div className="primitive-card-footer flex items-center justify-end gap-2 border-t border-line">{footer}</div>}
    </div>
  );
}
