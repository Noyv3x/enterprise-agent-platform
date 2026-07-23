import { notification } from "antd";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n";

export type ToastType = "ok" | "error";

export interface ToastOptions {
  type?: ToastType;
  title?: string;
}

export type ToastFn = (message: string, options?: ToastOptions) => void;

interface ToastStore {
  toast: ToastFn;
}

const ToastContext = createContext<ToastStore | null>(null);

/* Data actions run outside React, so keep the small imperative bridge while
   Ant Design owns rendering, focus-safe dismissal, animation, and timers. */
let toastSingleton: ToastFn | null = null;

export function toast(message: string, options?: ToastOptions): void {
  toastSingleton?.(message, options);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [api, contextHolder] = notification.useNotification({
    placement: "topRight",
    stack: { threshold: 4 },
  });
  const sequence = useRef(0);

  const addToast = useCallback<ToastFn>((message, options) => {
    const type = options?.type ?? "error";
    const title = options?.title;
    const open = type === "ok" ? api.success : api.error;
    sequence.current += 1;
    open({
      key: `platform-toast-${sequence.current}`,
      title: title ?? message,
      description: title ? message : undefined,
      duration: type === "ok" ? 3.2 : 6.5,
      pauseOnHover: true,
      role: type === "error" ? "alert" : "status",
      className: `platform-notification platform-notification--${type}`,
      closable: { "aria-label": t("toast.close") },
    });
  }, [api, t]);

  useEffect(() => {
    toastSingleton = addToast;
    return () => {
      if (toastSingleton === addToast) toastSingleton = null;
      api.destroy();
    };
  }, [addToast, api]);

  const value = useMemo<ToastStore>(() => ({ toast: addToast }), [addToast]);

  return (
    <ToastContext.Provider value={value}>
      {contextHolder}
      {children}
    </ToastContext.Provider>
  );
}

export function useToastStore(): ToastStore {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a <ToastProvider>");
  return ctx;
}
