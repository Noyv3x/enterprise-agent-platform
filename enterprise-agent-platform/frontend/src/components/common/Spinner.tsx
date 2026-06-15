/* <Spinner/> — the spinning loader icon (legacy icon("loader", {cls:"spin"})). */

import { Icon } from "./Icon";

export function Spinner({ size = 18 }: { size?: number }) {
  return <Icon name="loader" size={size} cls="spin" />;
}
