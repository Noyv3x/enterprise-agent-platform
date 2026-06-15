/* <EmptyState icon title text/> — empty-state placeholder
   (legacy emptyState(iconName, title, text), legacy-app.js:358-364). */

import type { IconName } from "../../types";
import { Icon } from "./Icon";

export function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
