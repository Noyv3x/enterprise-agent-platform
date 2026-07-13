import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  level?: 1 | 2;
  className?: string;
}
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  level = 2,
  className,
}: PageHeaderProps) {
  const heading = level === 1 ? <h1>{title}</h1> : <h2>{title}</h2>;
  return (
    <header className={cx("page-header", className)}>
      <div className="page-header__copy">
        {eyebrow ? <div className="page-header__eyebrow">{eyebrow}</div> : null}
        {heading}
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
