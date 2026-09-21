// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { FieldworkProvider } from "./Fieldwork";

function WorkingDraft() {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  return <>
    <label>Draft<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <button onClick={() => setExpanded(value => !value)}>Details</button>
    {expanded && <section aria-label="Working view">Current work</section>}
  </>;
}

afterEach(cleanup);

it("keeps unsent input, expanded content and focus when motion preferences change", async () => {
  const user = userEvent.setup();
  const view = render(<FieldworkProvider mode="light" motion><WorkingDraft /></FieldworkProvider>);
  await user.type(screen.getByRole("textbox", { name: "Draft" }), "Unsent working note");
  await user.click(screen.getByRole("button", { name: "Details" }));
  await user.click(screen.getByRole("textbox", { name: "Draft" }));

  view.rerender(<FieldworkProvider mode="light" motion={false}><WorkingDraft /></FieldworkProvider>);
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Unsent working note");
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveFocus();
  expect(screen.getByRole("region", { name: "Working view" })).toBeVisible();

  view.rerender(<FieldworkProvider mode="dark" motion><WorkingDraft /></FieldworkProvider>);
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Unsent working note");
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveFocus();
  expect(screen.getByRole("region", { name: "Working view" })).toBeVisible();
});
