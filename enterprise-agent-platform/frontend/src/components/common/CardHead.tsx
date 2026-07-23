/* <CardHead title icon desc extra/> — reusable card header
   (legacy cardHead(title, iconName, {desc, extra}), legacy-app.js:334-342). */

import type { ReactNode } from "react";
import type { IconName } from "../../types";
import { Icon } from "./Icon";

export interface CardHeadProps {
  title: ReactNode;
  icon?: IconName;
  desc?: ReactNode;
  extra?: ReactNode;
}

export function CardHead({ title, icon, desc, extra }: CardHeadProps) {
  return (
    <div className="card__head">
      <div>
        <h3 className="card__title">
          {icon ? <Icon name={icon} /> : null}
          <span>{title}</span>
        </h3>
        {desc ? <div className="card__desc">{desc}</div> : null}
      </div>
      {extra ?? null}
    </div>
  );
}
