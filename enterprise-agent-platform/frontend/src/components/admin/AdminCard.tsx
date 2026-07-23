import { Card } from "antd";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export function AdminCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card
      className={cx("eap-admin-card", className)}
      styles={{
        body: {
          display: "grid",
          gap: 16,
          minWidth: 0,
          padding: "var(--eap-admin-card-body-padding, 20px)",
        },
      }}
    >
      {children}
    </Card>
  );
}
