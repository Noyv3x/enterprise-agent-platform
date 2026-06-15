/* useConfirm — a promise-based confirm() backed by <ConfirmDialog>, replacing
   the blocking window.confirm() the legacy admin deletes used. The owning
   component renders the returned `dialog` element and awaits `confirm(message)`,
   which resolves true on confirm and false on cancel (cancel is a no-op).

   Kept as a .ts file (manifest) by building the element with createElement
   instead of JSX. */

import { createElement, useCallback, useState, type ReactElement } from "react";
import { ConfirmDialog } from "../components/common/ConfirmDialog";

export interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

export interface UseConfirm {
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  dialog: ReactElement | null;
}

export function useConfirm(): UseConfirm {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback(
    (message: string, options?: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setRequest({ message, ...options, resolve });
      }),
    [],
  );

  const close = useCallback((ok: boolean) => {
    // resolve is idempotent, so the StrictMode double-invoked updater is safe.
    setRequest((current) => {
      current?.resolve(ok);
      return null;
    });
  }, []);

  const dialog = request
    ? createElement(ConfirmDialog, {
        message: request.message,
        title: request.title,
        confirmText: request.confirmText,
        cancelText: request.cancelText,
        danger: request.danger,
        onConfirm: () => close(true),
        onCancel: () => close(false),
      })
    : null;

  return { confirm, dialog };
}
