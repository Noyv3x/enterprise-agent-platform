/* <StatusBadge ok label/> — a status pill. */

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
