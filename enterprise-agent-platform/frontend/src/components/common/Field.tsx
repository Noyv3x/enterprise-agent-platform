/* <Field label>{control}</Field> — a labeled control (legacy field(label, control),
   legacy-app.js:331-333). The <label> wraps the control for implicit a11y
   association, exactly as the legacy markup. */

import type { ReactNode } from "react";

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
