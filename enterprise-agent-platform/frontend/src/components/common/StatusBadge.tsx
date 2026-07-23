/* <StatusBadge ok label/> — a status pill (legacy statusBadge(ok, label),
   legacy-app.js:343-348). */

import { Badge } from "antd";

export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge
      className={`status ${ok ? "status--ok" : "status--warn"}`}
      status={ok ? "success" : "warning"}
      text={<span className="status__label">{label}</span>}
    />
  );
}
