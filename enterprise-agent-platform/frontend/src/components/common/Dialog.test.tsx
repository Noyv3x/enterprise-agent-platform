// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { ConfigProvider } from "antd";
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
  return {
    appRoot,
    ...render(
      <ConfigProvider prefixCls="eap" theme={{ token: { motion: false } }}>
        <I18nProvider>{ui}</I18nProvider>
      </ConfigProvider>,
      { container: appRoot },
    ),
  };
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
  it("closes on Escape and restores focus to the opener", async () => {
    const user = userEvent.setup();
    mount(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.tab();
    expect(trigger).not.toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("only lets the top modal handle keyboard input", async () => {
    const user = userEvent.setup();
    mount(<NestedHarness />);
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(screen.getByText("Discard changes")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.queryByText("Discard changes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
