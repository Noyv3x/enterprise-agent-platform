import type { DialogProps } from "./Dialog";
import { Dialog } from "./Dialog";

/** Right-side workspace panel that becomes a bottom sheet on narrow screens. */
export function Drawer(props: DialogProps) {
  return <Dialog {...props} variant="drawer" />;
}
