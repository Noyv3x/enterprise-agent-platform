// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Switch } from "./Switch";
import { SegmentedControl } from "./SegmentedControl";
import TaskRows from "../primitives/TaskRows";

afterEach(cleanup);

it("changes form settings without submitting until the submit button is activated", async () => {
  const submit = vi.fn();
  function SettingsForm() {
    const [checked, setChecked] = useState(false);
    const [mode, setMode] = useState("Manual");
    return <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Switch label="Automatic updates" checked={checked} onChange={setChecked} />
      <SegmentedControl options={["Manual", "Scheduled"]} value={mode} onChange={setMode} />
      <button type="submit">Save settings</button>
    </form>;
  }
  const user = userEvent.setup();
  render(<SettingsForm />);
  await user.click(screen.getByRole("switch", { name: "Automatic updates" }));
  expect(screen.getByRole("switch")).toBeChecked();
  await user.click(screen.getByRole("tab", { name: "Scheduled" }));
  expect(screen.getByRole("tab", { name: "Scheduled" })).toHaveAttribute("aria-selected", "true");
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  expect(submit).toHaveBeenCalledTimes(1);
});

it("associates repeated task keys with their own list's details", async () => {
  const user = userEvent.setup();
  render(<>
    <TaskRows rows={[{ key: "1", label: "First task", status: "idle", details: [], children: "First details" }]} />
    <TaskRows rows={[{ key: "1", label: "Second task", status: "idle", details: [], children: "Second details" }]} />
  </>);
  const first = screen.getByRole("button", { name: "First task" });
  const second = screen.getByRole("button", { name: "Second task" });
  expect(document.getElementById(first.getAttribute("aria-controls")!)).toContainElement(screen.getByText("First details"));
  expect(document.getElementById(second.getAttribute("aria-controls")!)).toContainElement(screen.getByText("Second details"));
  await user.click(second);
  expect(second).toHaveAttribute("aria-expanded", "true");
  expect(first).toHaveAttribute("aria-expanded", "false");
});
