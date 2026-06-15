/* <Scrim/> — the mobile drawer dismiss button (legacy-app.js:412). A real,
   keyboard-dismissable <button>; focusable only while the drawer is open
   (tabindex toggles). Desktop CSS hides it. */

export function Scrim({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <button
      className="scrim"
      type="button"
      aria-label="关闭菜单"
      tabIndex={open ? 0 : -1}
      onClick={onClose}
    />
  );
}
