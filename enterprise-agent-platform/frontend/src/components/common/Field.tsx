import { Form } from "antd";
import type { ReactNode } from "react";

/** Compact vertical field composition backed by Ant Design Form.Item. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Form.Item className="eap-field" label={label} layout="vertical" colon={false}>
      {children}
    </Form.Item>
  );
}
