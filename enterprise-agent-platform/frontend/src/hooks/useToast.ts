/* useToast — the imperative toast() enqueue for components. Non-component code
   should import the module-level toast() singleton from context/ToastContext. */

import { useToastStore, type ToastFn } from "../context/ToastContext";

export function useToast(): ToastFn {
  return useToastStore().toast;
}
