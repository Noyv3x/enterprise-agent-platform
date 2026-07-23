import { Empty, Typography } from "antd";
import type { IconName } from "../../types";
import { Icon } from "./Icon";

export function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <Empty
      className="eap-empty-state"
      classNames={{ image: "eap-empty-state__image", description: "eap-empty-state__description" }}
      image={<span className="eap-empty-state__icon"><Icon name={icon} size={26} /></span>}
      description={(
        <span className="eap-empty-state__copy">
          <Typography.Title level={3}>{title}</Typography.Title>
          <Typography.Text type="secondary">{text}</Typography.Text>
        </span>
      )}
    />
  );
}
