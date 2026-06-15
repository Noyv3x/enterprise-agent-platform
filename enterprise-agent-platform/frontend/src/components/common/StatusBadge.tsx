/* <StatusBadge ok label/> — a status pill (legacy statusBadge(ok, label),
   legacy-app.js:343-348). */

import { cx } from "../../lib/cx";

export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cx("status", ok ? "status--ok" : "status--warn")}>
      <span className={cx("dot", !ok && "dot--warn")} />
      {label}
    </span>
  );
}
