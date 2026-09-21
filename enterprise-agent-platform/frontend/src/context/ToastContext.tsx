import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { Button } from "../components/ui/beautiful/Controls";
import { Glyph } from "../components/ui/beautiful/Glyph";
import { useBeautifulContainer } from "../components/ui/beautiful/Root";

export type ToastType = "ok" | "error";
export interface ToastOptions { type?: ToastType; title?: string }
export type ToastFn = (message: string, options?: ToastOptions) => void;
interface ToastStore { toast: ToastFn }
interface ToastItem { id: number; message: string; title?: string; type: ToastType }
const ToastContext = createContext<ToastStore | null>(null);
let toastSingleton: ToastFn | null = null;
export function toast(message: string, options?: ToastOptions): void { toastSingleton?.(message, options); }

function ToastCard({ item, dismiss }: { item: ToastItem; dismiss: (id: number) => void }) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.type === "ok" ? 3200 : 6500);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss(item.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [dismiss, item.id, paused]);

  return (
    <div
      className={`bui-toast bui-toast--${item.type}`}
      role={item.type === "error" ? "alert" : "status"}
      aria-live={item.type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div>
        <div className="bui-toast-title">{item.title ?? item.message}</div>
        {item.title && <div className="bui-toast-description">{item.message}</div>}
      </div>
      <Button variant="quiet" size="xs" aria-label={t("toast.close")} icon={<Glyph name="close" size={14} />} onClick={() => dismiss(item.id)} />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const container = useBeautifulContainer();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const addToast = useCallback<ToastFn>((message, options) => {
    const item: ToastItem = { id: nextId.current++, message, title: options?.title, type: options?.type ?? "error" };
    setItems((current) => [...current.slice(-3), item]);
  }, []);
  useEffect(() => {
    toastSingleton = addToast;
    return () => { if (toastSingleton === addToast) toastSingleton = null; };
  }, [addToast]);
  const value = useMemo(() => ({ toast: addToast }), [addToast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div data-bui-toast-layer="" className="bui-toast-viewport">
          {items.map((item) => <ToastCard key={item.id} item={item} dismiss={dismiss} />)}
        </div>,
        container?.current ?? document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToastStore(): ToastStore {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within a <ToastProvider>");
  return context;
}
