/* Form layout — label/hint/error wiring and the section card. Platform addition composed from upstream
 * FineTuneCard (card bar, card pad, 12.5px medium section labels) and UseThisHarness (footer rule). */
import { createContext, useContext, useId, type ReactNode } from "react";
import { cn } from "../cn";
import { Icon } from "./Icon";

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** The id / aria wiring a control inside a <Field> picks up; explicit props win. */
export function useFieldControl(props: { id?: string; "aria-describedby"?: string; invalid?: boolean; required?: boolean }) {
  const field = useContext(FieldContext);
  const describedBy = [field?.describedBy, props["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  return {
    id: props.id ?? field?.id,
    "aria-describedby": describedBy,
    invalid: props.invalid ?? field?.invalid ?? false,
    required: props.required ?? field?.required ?? false,
  };
}

/** A labelled control: label above, then hint or error below. `group` labels a set of controls (switches,
 * segmented controls) instead of one input. */
export function Field({
  label,
  hint,
  error,
  required = false,
  group = false,
  id,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  group?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const controlId = id ?? `${generated}-control`;
  const labelId = `${generated}-label`;
  const noteId = `${generated}-note`;
  const note = error || hint;
  const labelClass = "text-[12.5px] font-medium text-ink";
  return (
    <FieldContext.Provider value={{ id: controlId, describedBy: note ? noteId : undefined, invalid: Boolean(error), required }}>
      <div
        role={group ? "group" : undefined}
        aria-labelledby={group ? labelId : undefined}
        aria-describedby={group && note ? noteId : undefined}
        className={cn("flex min-w-0 flex-col gap-1.5", className)}
      >
        {group ? (
          <span id={labelId} className={labelClass}>{label}</span>
        ) : (
          <label id={labelId} htmlFor={controlId} className={cn(labelClass, "self-start")}>
            {label}
            {required && <span aria-hidden className="ml-0.5 text-ink-2">*</span>}
          </label>
        )}
        {children}
        {error ? (
          <p id={noteId} className="flex items-start gap-1 text-[12px] leading-[1.4] text-red-ink">
            <Icon name="danger" size={14} strokeWidth={2} className="mt-px shrink-0" />
            <span>{error}</span>
          </p>
        ) : hint ? (
          <p id={noteId} className="text-[12px] leading-[1.4] text-ink-2">{hint}</p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** Two columns from `sm` up; one column on phones. */
export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid min-w-0 gap-3 sm:grid-cols-2", className)}>{children}</div>;
}

/** Actions row: status on the left, buttons on the right (primary last). */
export function FormActions({ status, children, className }: { status?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-end gap-2", className)}>
      {status && <div className="mr-auto min-w-0 text-[12px] text-ink-2">{status}</div>}
      {children}
    </div>
  );
}

/** A settings/form card: title bar, padded body, optional footer that keeps the save button inside its form.
 * Pass `onSubmit` to render the section as a <form>. */
export function FormSection({
  title,
  description,
  actions,
  footer,
  onSubmit,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** small controls at the right of the title bar */
  actions?: ReactNode;
  /** footer row, usually <FormActions> */
  footer?: ReactNode;
  onSubmit?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const body = (
    <>
      <div className="primitive-card-bar flex items-start justify-between gap-3 border-b border-line">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[13px] font-medium text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[12.5px] leading-[1.45] text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <div className="primitive-card-pad flex flex-col gap-3.5">{children}</div>
      {footer && <div className="primitive-card-footer border-t border-line">{footer}</div>}
    </>
  );
  const sectionClass = cn("min-w-0 rounded-card bg-surface shadow-card", className);
  if (onSubmit) {
    return (
      <form
        aria-labelledby={titleId}
        noValidate
        className={sectionClass}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {body}
      </form>
    );
  }
  return <section aria-labelledby={titleId} className={sectionClass}>{body}</section>;
}

/** Read-only facts (term above value), two columns from `sm` up. */
export function DescriptionList({ items, className }: { items: { key: string; label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[12px] text-ink-2">{item.label}</dt>
          <dd className="min-w-0 truncate text-[13px] text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
