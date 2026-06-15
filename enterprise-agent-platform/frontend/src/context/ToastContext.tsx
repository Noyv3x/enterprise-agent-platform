/* ToastContext — the React port of the legacy toast system
   (toast() + #toast-stack, legacy-app.js:247-265).

   - <ToastProvider> owns the toast list + timers and registers a MODULE-LEVEL
     toast() singleton so non-component code (api(), session actions, runBusy)
     can raise toasts.
   - <ToastViewport> PORTALS the toasts into the existing #toast-stack element,
     preserving its aria-live region identity across view changes (the element
     lives outside the app subtree, so view teardown never drops in-flight toasts).
   - Each toast auto-dismisses (3200ms ok / 6500ms otherwise) and animates out via
     the .is-leaving class, removed on animationend — exactly the legacy DOM. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { Icon } from "../components/common/Icon";

export type ToastType = "ok" | "error";

export interface ToastOptions {
  type?: ToastType;
  title?: string;
}

export type ToastFn = (message: string, options?: ToastOptions) => void;

interface ToastItem {
  id: number;
  type: ToastType;
  title?: string;
  message: string;
  leaving: boolean;
}

interface ToastStore {
  toasts: ToastItem[];
  toast: ToastFn;
  dismiss: (id: number) => void;
  remove: (id: number) => void;
}

const ToastContext = createContext<ToastStore | null>(null);

/* Module-level singleton: the provider registers its enqueue fn here so callers
   outside the React tree can toast (mirrors registerSessionExpiredHandler). */
let toastSingleton: ToastFn | null = null;

export function toast(message: string, options?: ToastOptions): void {
  toastSingleton?.(message, options);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, number>>(new Map());
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
  }, []);

  const addToast = useCallback<ToastFn>(
    (message, options) => {
      const id = (seq.current += 1);
      const type: ToastType = options?.type ?? "error";
      setToasts((prev) => [...prev, { id, type, title: options?.title, message, leaving: false }]);
      const ttl = type === "ok" ? 3200 : 6500;
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), ttl),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    toastSingleton = addToast;
    return () => {
      if (toastSingleton === addToast) toastSingleton = null;
    };
  }, [addToast]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) window.clearTimeout(timer);
    };
  }, []);

  const value = useMemo<ToastStore>(
    () => ({ toasts, toast: addToast, dismiss, remove }),
    [toasts, addToast, dismiss, remove],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** Hook surface for components; ToastViewport reads the full store directly. */
export function useToastStore(): ToastStore {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}

export function ToastViewport() {
  const ctx = useContext(ToastContext);
  const [stack, setStack] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setStack(document.getElementById("toast-stack"));
  }, []);

  if (!ctx || !stack) return null;

  return createPortal(
    ctx.toasts.map((item) => (
      <ToastNode
        key={item.id}
        item={item}
        onDismiss={() => ctx.dismiss(item.id)}
        onRemove={() => ctx.remove(item.id)}
      />
    )),
    stack,
  );
}

function ToastNode({
  item,
  onDismiss,
  onRemove,
}: {
  item: ToastItem;
  onDismiss: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cx("toast", `toast--${item.type}`, item.leaving && "is-leaving")}
      role="status"
      onAnimationEnd={() => {
        // The enter animation (toast-in) also fires animationend; only remove
        // once the leave animation (toast-out, via .is-leaving) has played.
        if (item.leaving) onRemove();
      }}
    >
      <div className="toast__icon">
        <Icon name={item.type === "ok" ? "checkCircle" : "alert"} size={18} />
      </div>
      <div className="toast__body">
        {item.title ? <div className="toast__title">{item.title}</div> : null}
        <div className="toast__msg">{item.message}</div>
      </div>
      <button className="icon-btn toast__close" type="button" title="关闭" onClick={onDismiss}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
