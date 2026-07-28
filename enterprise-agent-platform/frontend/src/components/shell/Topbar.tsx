/* <Topbar/> — the main column header: mobile hamburger, contextual title/subtitle
   and right-aligned actions. */

import { MenuButton } from "./MenuButton";
import { TopbarActions } from "./TopbarActions";
import { TopbarTitle } from "./TopbarTitle";

export function Topbar() {
  return (
    <header className="topbar">
      <MenuButton />
      <TopbarTitle />
      <TopbarActions />
    </header>
  );
}
