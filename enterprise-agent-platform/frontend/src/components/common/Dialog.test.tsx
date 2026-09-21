// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { BeautifulRoot } from "../ui/beautiful/Root";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { Dialog } from "./Dialog";
import { Drawer } from "./Drawer";

beforeEach(() => {
  // jsdom has no layout; native focus locking excludes zero-sized controls.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const hidden = !this.isConnected || getComputedStyle(this).display === "none";
    return new DOMRect(0, 0, hidden ? 0 : 100, hidden ? 0 : 32);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(ui: React.ReactNode) {
  const appRoot = document.createElement("div");
  appRoot.id = "react-root";
  document.body.append(appRoot);
  return {
    appRoot,
    ...render(
      <BeautifulRoot mode="light" motion={false}>
        <I18nProvider>{ui}</I18nProvider>
      </BeautifulRoot>,
      { container: appRoot },
    ),
  };
}

function DialogHarness({ closeOnBackdrop = true }: { closeOnBackdrop?: boolean }) {
  const [open, setOpen] = useState(false);
  const save = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Preferences" closeOnBackdrop={closeOnBackdrop} initialFocusRef={save}>
        <button ref={save} type="button">Save</button>
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

function ConditionalHarness({ Overlay, focusNext = false }: { Overlay: typeof Dialog; focusNext?: boolean }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(false);
  const close = () => {
    setOpen(false);
    if (focusNext) setNext(true);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open editor</button>
      {open && (
        <Overlay open onClose={close} title="Editor">
          <button type="button" onClick={close}>Complete</button>
        </Overlay>
      )}
      {next && <input aria-label="Next task" autoFocus />}
    </>
  );
}

describe("Dialog", () => {
  it("focuses the requested control, closes on Escape, and restores focus to the opener", async () => {
    const user = userEvent.setup();
    mount(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveFocus());
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab({ shift: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps a dialog open on its disabled backdrop but still permits Escape", async () => {
    const user = userEvent.setup();
    mount(<DialogHarness closeOnBackdrop={false} />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    await user.click(dialog.parentElement!);
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("only lets the top modal handle keyboard input", async () => {
    const user = userEvent.setup();
    mount(<NestedHarness />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Account" })).toContainElement(document.activeElement as HTMLElement));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    const confirmation = screen.getByRole("dialog", { name: "Discard changes" });
    await waitFor(() => expect(confirmation).toContainElement(document.activeElement as HTMLElement));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard changes" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes only the confirmation on a nested backdrop click", async () => {
    const user = userEvent.setup();
    mount(<NestedHarness />);
    const discard = screen.getByRole("button", { name: "Discard" });
    await user.click(discard);
    const confirmation = screen.getByRole("dialog", { name: "Discard changes" });
    await waitFor(() => expect(confirmation).toContainElement(document.activeElement as HTMLElement));

    await user.click(confirmation.parentElement!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard changes" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
    await waitFor(() => expect(discard).toHaveFocus());
  });

  it.each([["Dialog", Dialog], ["Drawer", Drawer]] as const)(
    "restores the opener when an open %s is conditionally unmounted",
    async (_name, Overlay) => {
      const user = userEvent.setup();
      mount(<ConditionalHarness Overlay={Overlay} />);
      const opener = screen.getByRole("button", { name: "Open editor" });
      await user.click(opener);
      await user.click(screen.getByRole("button", { name: "Complete" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() => expect(opener).toHaveFocus());
    },
  );

  it("leaves a newly focused control alone after conditional drawer unmount", async () => {
    const user = userEvent.setup();
    mount(<ConditionalHarness Overlay={Drawer} focusNext />);
    await user.click(screen.getByRole("button", { name: "Open editor" }));
    await user.click(screen.getByRole("button", { name: "Complete" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Next task" })).toHaveFocus());
  });
});
