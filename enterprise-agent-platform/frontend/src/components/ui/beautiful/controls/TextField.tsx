/* Single- and multi-line text inputs. Platform addition in the upstream field look: --field fill, control radius 8,
 * shadow-inset-field, accent ring on focus (FineTuneCard ScrubField active state), 13.5px ink text. */
import { useState, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { useWords } from "../../../../words";
import { cn } from "../cn";
import { useFieldControl } from "./Field";
import { Icon } from "./Icon";

/** The shared field shell — also used by Select's trigger. */
export const fieldShell = `bui-field flex min-w-0 items-center rounded-control bg-field text-[13.5px] text-ink shadow-inset-field
  transition-[box-shadow,background-color,opacity] duration-150
  focus-within:shadow-[var(--shadow-inset-field),0_0_0_1px_var(--accent)]
  has-[[aria-invalid=true]]:shadow-[var(--shadow-inset-field),0_0_0_1px_var(--red)]
  has-[:disabled]:opacity-50 touch:text-[16px]`;

const inputClass = "h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-2 disabled:cursor-not-allowed";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  /** icon or text before the value */
  leading?: ReactNode;
  /** control after the value (clear button, unit) */
  trailing?: ReactNode;
  invalid?: boolean;
  /** `sm` is the 28px toolbar height; `md` 36px; both grow to 44px on touch */
  size?: "sm" | "md";
  /** wrapper (field shell) classes */
  className?: string;
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
};

export function TextField({ leading, trailing, invalid, size = "md", className, inputClassName, type = "text", ref, ...props }: TextFieldProps) {
  const w = useWords();
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"], invalid, required: props.required });
  const [revealed, setRevealed] = useState(false);
  const password = type === "password";
  return (
    <div className={cn(fieldShell, size === "sm" ? "h-7 gap-1.5 px-2 text-[13px]" : "h-9 gap-2 px-2.5", "touch:h-11", className)}>
      {leading && <span className="flex shrink-0 items-center text-ink-2">{leading}</span>}
      <input
        ref={ref}
        {...props}
        id={field.id}
        type={password && revealed ? "text" : type}
        required={field.required}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field["aria-describedby"]}
        className={cn(inputClass, inputClassName)}
      />
      {password && (
        <button
          type="button"
          aria-label={revealed ? w("Hide password", "隐藏密码", "隱藏密碼") : w("Show password", "显示密码", "顯示密碼")}
          aria-pressed={revealed}
          disabled={props.disabled}
          onClick={() => setRevealed((current) => !current)}
          className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 hover:text-ink touch:size-11"
        >
          <Icon name={revealed ? "eyeOff" : "eye"} size={16} />
        </button>
      )}
      {trailing && <span className="flex shrink-0 items-center text-ink-2">{trailing}</span>}
    </div>
  );
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  /** grows with its content between `rows` and `maxRows` lines */
  maxRows?: number;
  ref?: Ref<HTMLTextAreaElement>;
};

export function TextArea({ invalid, rows = 3, maxRows = 12, className, style, ref, ...props }: TextAreaProps) {
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"], invalid, required: props.required });
  return (
    <div className={cn(fieldShell, "items-stretch px-2.5 py-2", className)}>
      <textarea
        ref={ref}
        rows={rows}
        {...props}
        id={field.id}
        required={field.required}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field["aria-describedby"]}
        style={{ fieldSizing: "content", minHeight: `${rows * 1.45}em`, maxHeight: `${maxRows * 1.45}em`, ...style }}
        className={cn(inputClass, "resize-none leading-[1.45]")}
      />
    </div>
  );
}
