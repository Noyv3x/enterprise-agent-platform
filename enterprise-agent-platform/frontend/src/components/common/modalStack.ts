import { useEffect, useId, useRef, useSyncExternalStore } from "react";

const stack: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Coordinates keyboard ownership while Ant Modal and Drawer are nested. */
export function useModalLayer(open: boolean) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const existing = stack.indexOf(id);
    if (existing >= 0) stack.splice(existing, 1);
    stack.push(id);
    emit();
    return () => {
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
      emit();
    };
  }, [id, open]);

  return useSyncExternalStore(
    subscribe,
    () => open && stack[stack.length - 1] === id,
    () => false,
  );
}

export function useTopLayerEscape(active: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [active]);
}
