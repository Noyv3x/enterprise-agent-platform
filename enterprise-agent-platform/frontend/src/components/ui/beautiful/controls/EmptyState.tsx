/* EmptyState — upstream SearchList empty state: 32px inset icon tile with hairline, 13px medium title, 12px hint,
 * fade-in. Adds an optional next-step action so empty screens guide the user. */
import type { ReactElement, ReactNode } from "react";
import { cn } from "../cn";
import { Icon, type IconName } from "./Icon";

export function EmptyState({
  icon = "search",
  title,
  description,
  action,
  className,
}: {
  /** an Icon name or any node for the tile */
  icon?: IconName | ReactElement;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-1 px-4 py-8 text-center", className)}
      style={{ animation: "fade-in 250ms ease-out both" }}
    >
      <span aria-hidden className="mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-2 shadow-hairline">
        {typeof icon === "string" ? <Icon name={icon} size={15} /> : icon}
      </span>
      <span className="text-[13px] font-medium text-ink">{title}</span>
      {description && <span className="max-w-[44ch] text-[12px] leading-[1.45] text-ink-2">{description}</span>}
      {action && <div className="mt-3 flex items-center gap-2">{action}</div>}
    </div>
  );
}
