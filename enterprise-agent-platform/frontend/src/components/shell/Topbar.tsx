/* <Topbar/> — the main column header (legacy renderTopbar, legacy-app.js:519-536):
   mobile hamburger + contextual title/subtitle + right-aligned actions. */

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
