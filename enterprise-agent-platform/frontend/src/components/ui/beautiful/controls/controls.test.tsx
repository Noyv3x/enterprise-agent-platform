// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../../../i18n";
import { ConfirmDialog, Field, Menu, MultiSelect, Select, TextField } from ".";

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
