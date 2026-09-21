import type { ReactNode, RefObject } from "react";
import { useI18n } from "../../i18n";
import { Overlay } from "../ui/beautiful/Overlay";

export interface DialogProps {
  id?: string;
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
  afterOpenChange?: (open: boolean) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}
export function Dialog(props: DialogProps) {
  const { t } = useI18n();
  return <Overlay {...props} closeLabel={t("common.close")} />;
}
