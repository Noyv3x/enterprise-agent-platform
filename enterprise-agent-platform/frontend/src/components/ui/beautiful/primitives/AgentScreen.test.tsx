// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { Select, Sheet } from "../controls";
import AgentScreen from "./AgentScreen";

afterEach(cleanup);

function NestedViewer() {
  const [sheetOpen, setSheetOpen] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [tab, setTab] = useState("one");
  return (
    <I18nProvider>
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Computer">
        <AgentScreen
          agentName="Browser"
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          controlling
          controls={<button type="button">Hand back</button>}
          inputs={<Select aria-label="Tab" value={tab} onChange={setTab} options={[{ value: "one", label: "First page" }, { value: "two", label: "Second page" }]} />}
          labels={{ open: "Expand browser", collapse: "Collapse", connecting: "Connecting", screen: "Browser screen" }}
        />
      </Sheet>
    </I18nProvider>
  );
}

it("Escape dismisses the tab menu, then the viewer, without unmounting its computer sheet", async () => {
  const user = userEvent.setup();
  render(<NestedViewer />);
  const opener = screen.getByRole("button", { name: "Expand browser" });
  await user.click(opener);
  await user.click(screen.getByRole("combobox", { name: "Tab" }));
  expect(screen.getByRole("listbox")).toBeVisible();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Browser" })).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Computer" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Hand back" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Browser" })).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Computer" })).toBeVisible();
  expect(opener).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Computer" })).not.toBeInTheDocument();
});
