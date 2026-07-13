// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { Dialog } from "./Dialog";
import { Drawer } from "./Drawer";

afterEach(() => cleanup());

function mount(ui: React.ReactNode) {
  const appRoot = document.createElement("div");
  appRoot.id = "react-root";
  document.body.append(appRoot);
  return { appRoot, ...render(<I18nProvider>{ui}</I18nProvider>, { container: appRoot }) };
}

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Preferences">
        <button type="button">Save</button>
      </Dialog>
    </>
  );
}

function NestedHarness() {
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Account">
        <button type="button" onClick={() => setConfirmOpen(true)}>Discard</button>
      </Drawer>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Discard changes">
        <button type="button">Confirm</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("makes the application inert, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    const { appRoot } = mount(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeInTheDocument();
    expect(appRoot).toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(appRoot).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });

  it("only lets the top modal handle keyboard input", async () => {
    const user = userEvent.setup();
    mount(<NestedHarness />);
    await user.click(screen.getByRole("button", { name: "Discard" }));

    const modals = [...document.querySelectorAll<HTMLElement>(".modal")];
    expect(modals).toHaveLength(2);
    expect(modals[0]).toHaveAttribute("inert");
    expect(modals[0]).toHaveAttribute("aria-hidden", "true");
    expect(modals[1]).not.toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(document.querySelector(".modal")).not.toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
