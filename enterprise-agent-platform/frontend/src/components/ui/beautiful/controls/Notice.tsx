/* Notice — inline status message. Platform addition from upstream semantic tints (--accent-tint, --green-tint,
 * --orange-tint, --red-tint) with the mark color on the icon only; text stays ink / ink-2 so it reads at 4.5:1.
 * Danger and warning announce as alerts, info and success as polite status. */
import type { ReactNode } from "react";
import { useWords } from "../../../../words";
import { cn } from "../cn";
import { Icon, type IconName } from "./Icon";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const TONES: Record<NoticeTone, { fill: string; mark: string; icon: IconName }> = {
  info: { fill: "bg-accent-tint", mark: "text-accent-ink", icon: "info" },
  success: { fill: "bg-green-tint", mark: "text-green-ink", icon: "success" },
  warning: { fill: "bg-orange-tint", mark: "text-orange-ink", icon: "warning" },
  danger: { fill: "bg-red-tint", mark: "text-red-ink", icon: "danger" },
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
  onDismiss,
  className,
}: {
  tone?: NoticeTone;
  title: ReactNode;
  /** detail under the title */
  children?: ReactNode;
  /** a small button (Retry, Open settings) */
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const w = useWords();
  const style = TONES[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn("bui-notice flex min-w-0 items-start gap-2.5 rounded-card px-3 py-2.5 text-[13px]", style.fill, className)}
    >
      <Icon name={style.icon} size={16} strokeWidth={2} className={cn("mt-[1.5px] shrink-0", style.mark)} />
      <div className="min-w-0 flex-1">
        <div className="font-medium break-words text-ink">{title}</div>
        {children && <div className="mt-0.5 leading-[1.45] break-words text-ink-2">{children}</div>}
      </div>
      {action && <div className="-my-0.5 flex shrink-0 items-center gap-1">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          aria-label={w("Dismiss", "关闭提示", "關閉提示")}
          onClick={onDismiss}
          className="-my-0.5 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 hover:text-ink touch:size-11"
        >
          <Icon name="close" size={13} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
