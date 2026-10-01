/* Sheet — side panel shaped like the upstream harness's docked pane (14px window radius, hairline, page fill, 44px
 * header with a 13px semibold title and 24px icon controls), floated over a scrim with the overlay shadow. Full-bleed
 * on phones. Modal: focus loop, Escape, focus returns to the opener. */
import { useId, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useWords } from "../../../../words";
import { cn } from "../cn";
import { Icon } from "./Icon";
import { useModalFocus } from "./overlay";

export function Sheet({
  open,
  onClose,
  title,
  description,
  footer,
  initialFocusRef,
  width = 440,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** actions row pinned to the bottom; Cancel first, primary last */
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** panel width in px on wide screens */
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <SheetPanel onClose={onClose} title={title} description={description} footer={footer} initialFocusRef={initialFocusRef} width={width} className={className}>
      {children}
    </SheetPanel>
  );
}

function SheetPanel({
  onClose,
  title,
  description,
  footer,
  initialFocusRef,
  width,
  className,
  children,
}: {
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  width: number;
  className?: string;
  children: ReactNode;
}) {
  const w = useWords();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useModalFocus(true, panelRef, onClose, initialFocusRef);
  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div aria-hidden className="absolute inset-0 bg-scrim" style={{ animation: "fade-in 200ms ease-out both" }} onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "bui-window absolute inset-0 flex flex-col overflow-hidden bg-page outline-none sm:inset-y-2.5 sm:right-2.5 sm:left-auto sm:w-[var(--sheet-width)] sm:max-w-[calc(100vw-20px)] sm:rounded-window sm:border sm:border-line sm:shadow-overlay",
          className,
        )}
        // Custom property: the panel width applies from `sm` up; phones stay full-bleed.
        style={{ "--sheet-width": `${width}px`, animation: "sheet-in 280ms cubic-bezier(0.23,1,0.32,1) both" } as CSSProperties}
      >
        <div className="flex min-h-11 shrink-0 items-start gap-3 border-b border-line py-2.5 pr-2.5 pl-4">
          <div className="min-w-0 flex-1 pt-px">
            <h2 id={titleId} className="text-[13px] font-semibold text-ink">{title}</h2>
            {description && <p id={descriptionId} className="mt-0.5 text-[12.5px] leading-[1.45] text-ink-2">{description}</p>}
          </div>
          <button
            type="button"
            data-modal-close
            aria-label={w("Close", "关闭", "關閉")}
            onClick={onClose}
            className="-my-0.5 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink touch:size-11"
          >
            <Icon name="close" size={13} strokeWidth={2.2} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
