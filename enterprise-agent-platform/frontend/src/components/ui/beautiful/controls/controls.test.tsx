// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../../i18n";
import { ConfirmDialog, Field, Menu, MultiSelect, Select, StepScrubber, TextField } from ".";

const FRUIT = [
  { value: "apple", label: "Apple" },
  { value: "apricot", label: "Apricot" },
  { value: "banana", label: "Banana", disabled: true },
  { value: "cherry", label: "Cherry" },
] as const;
type Fruit = (typeof FRUIT)[number]["value"];

function SingleHarness({ searchable = false, onChange = vi.fn() }: { searchable?: boolean; onChange?: (value: Fruit) => void }) {
  const [value, setValue] = useState<Fruit>("apple");
  return (
    <I18nProvider>
      <Field label="Fruit" hint="Pick one">
        <Select
          value={value}
          searchable={searchable}
          options={FRUIT}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </Field>
    </I18nProvider>
  );
}

beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, "en"));
afterEach(cleanup);

describe("Select", () => {
  it("is labelled by its field and chooses with arrows, skipping disabled options", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SingleHarness onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Fruit" });
    expect(select).toHaveAccessibleDescription("Pick one");
    expect(select).toHaveTextContent("Apple");

    select.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeVisible();
    expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("cherry");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(select).toHaveTextContent("Cherry");
    expect(select).toHaveFocus();
  });

  it("jumps by typed prefix and closes on Escape without choosing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SingleHarness onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Fruit" });
    select.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("ap");
    expect(select).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Apricot" }).id);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("filters a searchable list and reports when nothing matches", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SingleHarness searchable onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    const search = screen.getByRole("combobox", { name: "Search" });
    expect(search).toHaveFocus();
    await user.type(search, "che");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Cherry"]);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("cherry");
    expect(screen.getByRole("combobox", { name: "Fruit" })).toHaveFocus();

    await user.click(screen.getByRole("combobox", { name: "Fruit" }));
    await user.type(screen.getByRole("combobox", { name: "Search" }), "zzz");
    expect(screen.getByText("No results found")).toBeVisible();
  });
});

describe("MultiSelect", () => {
  it("toggles options while open and removes chips", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [values, setValues] = useState<Fruit[]>(["apple"]);
      return (
        <I18nProvider>
          <Field label="Fruits">
            <MultiSelect values={values} options={FRUIT} onChange={setValues} />
          </Field>
          <output>{values.join(",")}</output>
        </I18nProvider>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "Fruits" }));
    await user.click(screen.getByRole("option", { name: "Cherry" }));
    expect(screen.getByRole("listbox")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("apple,cherry");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove Apple" }));
    expect(screen.getByRole("status")).toHaveTextContent("cherry");
  });
});

describe("ConfirmDialog", () => {
  it("focuses Cancel for destructive actions, closes on Escape, and returns focus to the opener", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <I18nProvider>
          <button type="button" onClick={() => setOpen(true)}>Delete chat</button>
          <ConfirmDialog open={open} tone="danger" title="Delete chat?" description="This cannot be undone." confirmLabel="Delete" onConfirm={onConfirm} onCancel={() => setOpen(false)} />
        </I18nProvider>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete chat" });
    await user.click(opener);
    const dialog = screen.getByRole("alertdialog", { name: "Delete chat?" });
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Menu", () => {
  it("opens from the keyboard, moves with arrows and runs the chosen item", async () => {
    const user = userEvent.setup();
    const rename = vi.fn();
    const remove = vi.fn();
    render(
      <Menu
        label="Chat actions"
        items={[
          { key: "rename", label: "Rename", onSelect: rename },
          { key: "sep", separator: true },
          { key: "delete", label: "Delete", tone: "danger", onSelect: remove },
        ]}
        trigger={(props) => <button type="button" {...props}>Actions</button>}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    await user.keyboard("{ArrowDown}{Enter}");
    expect(remove).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("Field", () => {
  it("marks the control invalid and describes it with the error", () => {
    render(
      <I18nProvider>
        <Field label="Name" error="Enter a name">
          <TextField />
        </Field>
      </I18nProvider>,
    );
    const input = screen.getByLabelText("Name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a name");
  });
});

describe("StepScrubber", () => {
  function ScrubberHarness() {
    const [value, setValue] = useState(1);
    return <StepScrubber count={5} value={value} onChange={setValue} label="Step" valueText={(at) => `Step ${at + 1} of 5`} />;
  }

  it("steps with arrows, jumps with Home and End, and seeks where the pointer presses and drags", async () => {
    const user = userEvent.setup();
    render(<ScrubberHarness />);
    const slider = screen.getByRole("slider", { name: "Step" });
    expect(slider).toHaveAttribute("aria-valuenow", "2");
    expect(slider).toHaveAttribute("aria-valuetext", "Step 2 of 5");

    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuenow", "3");
    await user.keyboard("{End}");
    expect(slider).toHaveAttribute("aria-valuetext", "Step 5 of 5");
    await user.keyboard("{ArrowRight}{Home}{ArrowLeft}");
    expect(slider).toHaveAttribute("aria-valuenow", "1");

    // The track spans x 0–400: 300 is step 4, dragging to 100 lands on step 2.
    const track = slider.firstElementChild as HTMLElement;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, width: 400, top: 0, height: 4, right: 400, bottom: 4, x: 0, y: 0, toJSON: () => ({}) });
    await user.pointer([{ keys: "[MouseLeft>]", target: slider, coords: { clientX: 300 } }]);
    expect(slider).toHaveAttribute("aria-valuenow", "4");
    await user.pointer([{ target: slider, coords: { clientX: 100 } }, { keys: "[/MouseLeft]", target: slider }]);
    expect(slider).toHaveAttribute("aria-valuenow", "2");
  });

  it("is inert with fewer than two steps", async () => {
    const onChange = vi.fn();
    render(<StepScrubber count={1} value={0} onChange={onChange} label="Step" valueText={() => "Step 1 of 1"} />);
    const slider = screen.getByRole("slider", { name: "Step" });
    expect(slider).toHaveAttribute("aria-disabled", "true");
    expect(slider).not.toHaveAttribute("tabindex", "0");
    slider.focus();
    await userEvent.setup().keyboard("{End}");
    expect(onChange).not.toHaveBeenCalled();
  });
});
