/* Adapted from Beautiful UI Button, Switch, SegmentedControl and RecordsTable.
 * Copyright (c) 2026 Shane Levine. See NOTICE and LICENSE in this directory. */
import { createContext, useContext, useId, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Combobox } from "@base-ui/react/combobox";
import { Menu } from "@base-ui/react/menu";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { useBeautifulContainer } from "./Root";
import { useI18n } from "../../../i18n";

const FieldContext = createContext<{ id: string; descriptionId?: string; invalid: boolean } | null>(null);
const cn = (...values: Parameters<typeof clsx>) => twMerge(clsx(...values));
const buttonVariants = cva("bui-button inline-flex items-center justify-center font-medium select-none transition-[transform,background-color,opacity] duration-150 ease-out active:scale-[0.96] disabled:opacity-50 disabled:pointer-events-none", {
  variants: {
    variant: {
      primary: "bg-ink text-canvas hover:opacity-90",
      secondary: "bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover",
      ghost: "bg-hover-2 text-ink hover:bg-line-strong",
      accent: "bui-button-accent",
      danger: "bg-red-tint text-red hover:opacity-80",
      success: "bg-green-tint text-green hover:opacity-80",
      quiet: "text-ink hover:bg-hover",
    },
    size: { xs: "h-7 rounded-full px-2.5 text-xs font-normal leading-none gap-1", sm: "bui-button-sm px-3 text-sm leading-none rounded-full gap-1.5", md: "px-4 py-2.5 text-sm leading-none rounded-full gap-2" },
  }, defaultVariants: { variant: "secondary", size: "md" },
});
export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: "primary" | "secondary" | "ghost" | "accent" | "danger" | "success" | "quiet";
  size?: "xs" | "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}
export function Button({ variant, size, className, loading, icon, children, disabled, type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined}>{loading ? <span className="bui-spinner" aria-hidden="true" /> : icon}{children}</button>;
}
export function Input({ invalid, className, id, ...props }: ComponentPropsWithRef<"input"> & { invalid?: boolean }) {
  const field = useContext(FieldContext);
  return <input id={id ?? field?.id} aria-describedby={field?.descriptionId} {...props} aria-invalid={invalid || props["aria-invalid"] || field?.invalid || undefined} className={cn("bui-input", className)} />;
}
export function Textarea({ invalid, className, id, ...props }: ComponentPropsWithRef<"textarea"> & { invalid?: boolean }) {
  const field = useContext(FieldContext);
  return <textarea id={id ?? field?.id} aria-describedby={field?.descriptionId} {...props} aria-invalid={invalid || props["aria-invalid"] || field?.invalid || undefined} className={cn("bui-input bui-textarea", className)} />;
}
export function Field({ label, htmlFor, error, hint, children }: { label?: ReactNode; htmlFor?: string; error?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const descriptionId = error || hint ? `${id}-description` : undefined;
  return <FieldContext.Provider value={{ id, descriptionId, invalid: Boolean(error) }}><div className="bui-field">{label && <label htmlFor={id}>{label}</label>}{children}{error ? <div id={descriptionId} className="bui-field-error" role="alert">{error}</div> : hint ? <div id={descriptionId} className="bui-field-hint">{hint}</div> : null}</div></FieldContext.Provider>;
}
export interface SelectOption { value: string | number; label: ReactNode; disabled?: boolean }
export interface SelectProps { options: readonly SelectOption[]; value: string | number | null; onChange: (value: string | number) => void; placeholder?: string; disabled?: boolean; id?: string; "aria-label"?: string; className?: string; searchable?: boolean }
export function Select({ options, value, onChange, placeholder, disabled, id, className, searchable, "aria-label": label }: SelectProps) {
  const container = useBeautifulContainer();
  const field = useContext(FieldContext);
  const { t } = useI18n();
  const controlId = id ?? field?.id;
  if (searchable) {
    const selected = options.find((option) => option.value === value) ?? null;
    return (
      <Combobox.Root<SelectOption> items={options} value={selected} onValueChange={(next) => { if (next) onChange(next.value); }} itemToStringLabel={(item) => typeof item.label === "string" ? item.label : String(item.value)} isItemEqualToValue={(a, b) => a.value === b.value} disabled={disabled}>
        <div className={cn("bui-combobox", className)}>
          <Combobox.Input id={controlId} aria-label={label} aria-describedby={field?.descriptionId} aria-invalid={field?.invalid || undefined} placeholder={placeholder} className="bui-input" />
          <Combobox.Trigger className="bui-combobox-trigger" aria-label={label} aria-labelledby={!label ? controlId : undefined}>⌄</Combobox.Trigger>
        </div>
        <Combobox.Portal container={container}><Combobox.Positioner sideOffset={4} className="bui-popup-positioner"><Combobox.Popup className="bui-select-popup">
          <Combobox.Empty className="bui-option">{options.length ? t("common.noMatches") : t("common.noOptions")}</Combobox.Empty>
          <Combobox.List>{(option: SelectOption) => <Combobox.Item key={option.value} value={option} disabled={option.disabled} className="bui-option">{option.label}<Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List>
        </Combobox.Popup></Combobox.Positioner></Combobox.Portal>
      </Combobox.Root>
    );
  }
  return (
    <BaseSelect.Root<string | number> value={value} onValueChange={(next) => { if (next !== null) onChange(next); }} items={options} disabled={disabled}>
      <BaseSelect.Trigger id={controlId} aria-label={label} aria-describedby={field?.descriptionId} aria-invalid={field?.invalid || undefined} className={cn("bui-input bui-select", className)}><BaseSelect.Value placeholder={placeholder} /><BaseSelect.Icon>⌄</BaseSelect.Icon></BaseSelect.Trigger>
      <BaseSelect.Portal container={container}><BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="bui-popup-positioner"><BaseSelect.Popup className="bui-select-popup">
        {!options.length && <div className="bui-option" role="status">{t("common.noOptions")}</div>}
        <BaseSelect.List>{options.map((option) => <BaseSelect.Item key={option.value} value={option.value} disabled={option.disabled} className="bui-option"><BaseSelect.ItemText>{option.label}</BaseSelect.ItemText><BaseSelect.ItemIndicator>✓</BaseSelect.ItemIndicator></BaseSelect.Item>)}</BaseSelect.List>
      </BaseSelect.Popup></BaseSelect.Positioner></BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
interface ToggleProps { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; "aria-label"?: string; children?: ReactNode }
export function Switch({ checked, onChange, children, id, ...props }: ToggleProps) {
  const labelId = useId();
  const field = useContext(FieldContext);
  return <span className="bui-inline"><button {...props} id={id ?? field?.id} aria-describedby={field?.descriptionId} type="button" role="switch" aria-checked={checked} aria-labelledby={children ? labelId : undefined} className="bui-switch" onClick={() => onChange(!checked)}><span /></button>{children && <span id={labelId}>{children}</span>}</span>;
}
export function Checkbox({ checked, onChange, children, id, ...props }: ToggleProps) {
  const field = useContext(FieldContext);
  return <label className="bui-checkbox"><input {...props} id={id ?? field?.id} aria-describedby={field?.descriptionId} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{children}</label>;
}
export function Tooltip({ title, children }: { title: ReactNode; children: ReactElement }) {
  const container = useBeautifulContainer();
  return <BaseTooltip.Root><BaseTooltip.Trigger render={children} /><BaseTooltip.Portal container={container}><BaseTooltip.Positioner sideOffset={8} className="bui-popup-positioner"><BaseTooltip.Popup className="bui-tooltip">{title}</BaseTooltip.Popup></BaseTooltip.Positioner></BaseTooltip.Portal></BaseTooltip.Root>;
}
export function SegmentedControl({ options, value, onChange, "aria-label": label }: { options: readonly { value: string; label: ReactNode; disabled?: boolean }[]; value: string; onChange: (value: string) => void; "aria-label"?: string }) {
  const name = useId();
  return <div className="bui-segmented" role="radiogroup" aria-label={label}>{options.map((option) => <label key={option.value} className="bui-segment"><input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} /><span>{option.label}</span></label>)}</div>;
}
export interface DataColumn<T> { key: string; title: ReactNode; render: (row: T) => ReactNode }
export function DataTable<T>({ columns, rows, rowKey, empty, "aria-label": label }: { columns: readonly DataColumn<T>[]; rows: readonly T[]; rowKey: (row: T) => string | number; empty?: ReactNode; "aria-label"?: string }) {
  return <div className="bui-table-scroll"><table className="bui-table" aria-label={label}><thead><tr>{columns.map((column) => <th scope="col" key={column.key}>{column.title}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={rowKey(row)}>{columns.map((column) => <td key={column.key}>{column.render(row)}</td>)}</tr>) : <tr><td colSpan={columns.length}>{empty}</td></tr>}</tbody></table></div>;
}
export function Progress({ value, label }: { value: number; label?: ReactNode }) {
  return <div className="bui-progress">{label && <span>{label}</span>}<progress max={100} value={Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0} aria-label={typeof label === "string" ? label : undefined} /></div>;
}
export function MenuButton({ label, items, disabled, "aria-label": ariaLabel }: { label: ReactNode; "aria-label"?: string; items: readonly { key: string; label: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean }[]; disabled?: boolean }) {
  const container = useBeautifulContainer();
  return <Menu.Root><Menu.Trigger render={<Button disabled={disabled} aria-label={ariaLabel} size="sm" />}>{label}</Menu.Trigger><Menu.Portal container={container}><Menu.Positioner sideOffset={4} className="bui-popup-positioner"><Menu.Popup className="bui-menu">{items.map((item) => <Menu.Item key={item.key} disabled={item.disabled} onClick={item.onSelect} className={cn("bui-menu-item", item.danger && "bui-danger-text")}>{item.label}</Menu.Item>)}</Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>;
}
