/* <Scrim/> — the mobile drawer dismiss button (legacy-app.js:412). A real,
   keyboard-dismissable <button>; focusable only while the drawer is open
   (tabindex toggles). Desktop CSS hides it. */

import { useI18n } from "../../i18n";

export function Scrim({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <button
      className="scrim"
      type="button"
      aria-label={t("nav.menu.close")}
      tabIndex={open ? 0 : -1}
      onClick={onClose}
    />
  );
}
