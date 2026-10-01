/* Select and MultiSelect — platform additions built from upstream FineTuneCard's Type menu (field trigger, raised
 * 10px popup, GlideMenu rows on --field) and SearchList (search row, empty state). Keyboard follows the WAI-ARIA
 * select-only combobox: arrows/Home/End/PageUp/PageDown move, Enter/Space choose, Escape/Tab close, typing jumps
 * to the next matching option; `searchable` adds a filter field that keeps the same keys. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import GlideMenu from "../primitives/GlideMenu";
import { useWords } from "../../../../words";
import { cn } from "../cn";
import { useFieldControl } from "./Field";
import { Icon } from "./Icon";
import { fieldShell } from "./TextField";
import { useAnchoredPosition, useOutsidePress } from "./overlay";

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  /** second line under the label */
  description?: string;
  /** extra text matched by search and typeahead */
  keywords?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

type CommonProps<T extends string> = {
  options: readonly SelectOption<T>[];
  placeholder?: string;
  /** adds a filter field to the popup (long lists such as time zones) */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** shown when the filter matches nothing */
  emptyLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  /** `sm` is the 28px toolbar height; `md` 36px; both grow to 44px on touch */
  size?: "sm" | "md";
  className?: string;
};

const TYPEAHEAD_RESET_MS = 500;

function matches<T extends string>(option: SelectOption<T>, query: string) {
  const needle = query.trim().toLowerCase();
  return !needle || `${option.label} ${option.keywords ?? ""} ${option.value}`.toLowerCase().includes(needle);
}

/** Listbox state shared by the Select and MultiSelect triggers and their popup. */
interface Listbox<T extends string> {
  open: boolean;
  show: () => void;
  /** closes; `restore` returns focus to the trigger (after a choice or Escape from the search field) */
  hide: (restore?: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
  active: number;
  setActive: (index: number) => void;
  visible: readonly SelectOption<T>[];
  choose: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, fromSearch?: boolean) => void;
}

function useListbox<T extends string>({
  options,
  searchable,
  selected,
  onChoose,
  multiple,
  triggerRef,
}: {
  options: readonly SelectOption<T>[];
  searchable: boolean;
  selected: readonly T[];
  onChoose: (value: T) => void;
  multiple: boolean;
  triggerRef: RefObject<HTMLElement | null>;
}): Listbox<T> {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const typeahead = useRef({ buffer: "", at: 0 });
  const visible = useMemo(() => (searchable ? options.filter((option) => matches(option, query)) : options), [options, query, searchable]);

  const step = (from: number, delta: number) => {
    if (visible.length === 0) return -1;
    let index = from;
    for (let tries = 0; tries < visible.length; tries += 1) {
      index = Math.min(visible.length - 1, Math.max(0, index + delta));
      if (!visible[index].disabled) return index;
      if (index === 0 || index === visible.length - 1) delta = -delta;
    }
    return from;
  };

  const show = () => {
    const current = visible.findIndex((option) => selected.includes(option.value));
    setQuery("");
    setActive(current >= 0 ? current : step(-1, 1));
    setOpen(true);
  };
  const hide = (restore = false) => {
    setOpen(false);
    setQuery("");
    if (restore) triggerRef.current?.focus();
  };
  const choose = (index: number) => {
    const option = visible[index];
    if (!option || option.disabled) return;
    onChoose(option.value);
    if (!multiple) hide(true);
  };

  const jump = (key: string) => {
    const now = Date.now();
    const state = typeahead.current;
    state.buffer = now - state.at > TYPEAHEAD_RESET_MS ? key : state.buffer + key;
    state.at = now;
    const repeated = state.buffer.split("").every((char) => char === state.buffer[0]);
    const needle = (repeated ? state.buffer[0] : state.buffer).toLowerCase();
    const start = repeated || active < 0 ? active + 1 : active;
    for (let offset = 0; offset < visible.length; offset += 1) {
      const index = (start + offset) % visible.length;
      if (!visible[index].disabled && visible[index].label.toLowerCase().startsWith(needle)) {
        setActive(index);
        return;
      }
    }
  };

  /** Keys for the focused trigger (closed or open) or the search field (open). */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, fromSearch = false) => {
    const { key } = event;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        show();
      } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        show();
        if (!searchable) jump(key);
        else setQuery(key);
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(step(active, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive(step(active, -1));
        break;
      case "Home":
        if (fromSearch) return;
        event.preventDefault();
        setActive(step(-1, 1));
        break;
      case "End":
        if (fromSearch) return;
        event.preventDefault();
        setActive(step(visible.length, -1));
        break;
      case "PageDown":
        event.preventDefault();
        setActive(step(Math.min(visible.length - 1, active + 9), 1));
        break;
      case "PageUp":
        event.preventDefault();
        setActive(step(Math.max(0, active - 9), -1));
        break;
      case "Enter":
        event.preventDefault();
        choose(active);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        hide(true);
        break;
      case "Tab":
        // From the portaled search field, Tab would leave the page order; land back on the trigger instead.
        if (fromSearch) event.preventDefault();
        hide(fromSearch);
        break;
      case " ":
        if (fromSearch) return;
        event.preventDefault();
        choose(active);
        break;
      default:
        if (!fromSearch && key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) jump(key);
    }
  };

  return { open, show, hide, query, setQuery, active, setActive, visible, choose, onKeyDown };
}

function ListboxPopup<T extends string>({
  listbox,
  listboxId,
  anchorRef,
  selected,
  multiple,
  searchable,
  searchPlaceholder,
  emptyLabel,
  label,
}: {
  listbox: Listbox<T>;
  listboxId: string;
  anchorRef: RefObject<HTMLElement | null>;
  selected: readonly T[];
  multiple: boolean;
  searchable: boolean;
  searchPlaceholder: string;
  emptyLabel: string;
  label?: string;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition({ open: listbox.open, anchorRef, popupRef, matchWidth: true });
  useOutsidePress(listbox.open, [anchorRef, popupRef], listbox.hide);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${listbox.active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [listbox.active]);

  if (!listbox.open) return null;
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  return createPortal(
    <div
      ref={popupRef}
      className="bui-popover z-[80] flex min-w-[180px] flex-col overflow-hidden rounded-[10px] bg-surface shadow-raised"
      style={{ ...style, animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {searchable && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover touch:h-11">
          <Icon name="search" size={14} strokeWidth={2} className="shrink-0 text-ink-2" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={listbox.active >= 0 ? optionId(listbox.active) : undefined}
            aria-label={searchPlaceholder}
            value={listbox.query}
            placeholder={searchPlaceholder}
            onChange={(event) => {
              listbox.setQuery(event.target.value);
              listbox.setActive(0);
            }}
            onKeyDown={(event) => listbox.onKeyDown(event, true)}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-2 touch:text-[16px]"
          />
        </div>
      )}
      {listbox.visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-6" style={{ animation: "fade-in 250ms ease-out both" }}>
          <span className="mb-1 flex size-8 items-center justify-center rounded-control bg-inset text-ink-2 shadow-hairline">
            <Icon name="search" size={15} />
          </span>
          <span className="text-[13px] font-medium text-ink">{emptyLabel}</span>
        </div>
      ) : (
        <div ref={listRef} className="min-h-0 overflow-y-auto p-1" style={{ maxHeight: 288 }}>
          <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-field" rowSelector="[role=option]">
            <div id={listboxId} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="flex flex-col gap-px">
              {listbox.visible.map((option, index) => {
                const isSelected = selected.includes(option.value);
                return (
                  <div
                    key={option.value}
                    id={optionId(index)}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => index !== listbox.active && !option.disabled && listbox.setActive(index)}
                    onClick={() => listbox.choose(index)}
                    className={cn(
                      "relative z-10 flex min-h-8 cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[13px] text-ink touch:min-h-11",
                      index === listbox.active && "bg-field group-hover/glide-menu:bg-transparent",
                      option.disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {multiple && (
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-[4px] transition-colors duration-100",
                          isSelected ? "bg-ink text-surface" : "bg-surface shadow-[inset_0_0_0_1px_var(--line-strong)]",
                        )}
                      >
                        {isSelected && <Icon name="check" size={11} strokeWidth={3} />}
                      </span>
                    )}
                    {option.icon && <span className="flex shrink-0 items-center text-ink-2">{option.icon}</span>}
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate", isSelected && !multiple && "font-medium")}>{option.label}</span>
                      {option.description && <span className="block truncate text-[12px] text-ink-2">{option.description}</span>}
                    </span>
                    {!multiple && isSelected && <Icon name="check" size={14} strokeWidth={2.4} className="shrink-0 text-ink" />}
                  </div>
                );
              })}
            </div>
          </GlideMenu>
        </div>
      )}
    </div>,
    document.body,
  );
}

const triggerSize = { sm: "h-7 px-2 text-[13px]", md: "h-9 px-2.5" } as const;

/** Single choice from a list. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  searchable = false,
  searchPlaceholder,
  emptyLabel,
  disabled,
  invalid,
  required,
  id,
  name,
  size = "md",
  className,
  ...aria
}: CommonProps<T> & { value: T | null | undefined; onChange: (value: T) => void }) {
  const w = useWords();
  const field = useFieldControl({ id, "aria-describedby": aria["aria-describedby"], invalid, required });
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = value == null ? [] : [value];
  const listbox = useListbox({ options, searchable, selected, onChoose: onChange, multiple: false, triggerRef });
  const current = options.find((option) => option.value === value);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={field.id}
        name={name}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={listbox.open}
        aria-controls={listbox.open ? listboxId : undefined}
        aria-activedescendant={listbox.open && !searchable && listbox.active >= 0 ? `${listboxId}-option-${listbox.active}` : undefined}
        aria-label={aria["aria-label"]}
        aria-describedby={field["aria-describedby"]}
        aria-invalid={field.invalid || undefined}
        aria-required={field.required || undefined}
        disabled={disabled}
        onClick={() => (listbox.open ? listbox.hide() : listbox.show())}
        onKeyDown={(event) => listbox.onKeyDown(event)}
        className={cn(
          fieldShell,
          triggerSize[size],
          "w-full gap-2 text-left focus-visible:shadow-[var(--shadow-inset-field),0_0_0_1px_var(--accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 touch:h-11",
          listbox.open && "shadow-[var(--shadow-inset-field),0_0_0_1px_var(--accent)]",
          field.invalid && "shadow-[var(--shadow-inset-field),0_0_0_1px_var(--red)]",
          className,
        )}
      >
        {current?.icon && <span className="flex shrink-0 items-center text-ink-2">{current.icon}</span>}
        <span className={cn("min-w-0 flex-1 truncate", current ? "text-ink" : "text-ink-2")}>
          {current?.label ?? placeholder ?? w("Select…", "请选择…", "請選擇…")}
        </span>
        <Icon
          name="chevronDown"
          size={13}
          strokeWidth={2.4}
          className="shrink-0 text-ink-2 transition-transform duration-200"
        />
      </button>
      <ListboxPopup
        listbox={listbox}
        listboxId={listboxId}
        anchorRef={triggerRef}
        selected={selected}
        multiple={false}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder ?? w("Search", "搜索", "搜尋")}
        emptyLabel={emptyLabel ?? w("No results found", "没有匹配项", "沒有符合項目")}
        label={aria["aria-label"]}
      />
    </>
  );
}

/** Several choices; the chosen ones show as removable chips in the field. */
export function MultiSelect<T extends string>({
  values,
  onChange,
  options,
  placeholder,
  searchable = false,
  searchPlaceholder,
  emptyLabel,
  disabled,
  invalid,
  required,
  id,
  size = "md",
  className,
  ...aria
}: CommonProps<T> & { values: readonly T[]; onChange: (values: T[]) => void }) {
  const w = useWords();
  const field = useFieldControl({ id, "aria-describedby": aria["aria-describedby"], invalid, required });
  const listboxId = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const toggle = (value: T) => onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  const listbox = useListbox({ options, searchable, selected: values, onChoose: toggle, multiple: true, triggerRef });
  const chosen = values.map((value) => options.find((option) => option.value === value) ?? { value, label: value });

  return (
    <>
      <div
        ref={shellRef}
        onMouseDown={(event) => {
          if (event.target === shellRef.current && !disabled) {
            event.preventDefault();
            triggerRef.current?.focus();
            if (!listbox.open) listbox.show();
          }
        }}
        className={cn(
          fieldShell,
          "w-full flex-wrap gap-1 py-1 pr-1.5 pl-1",
          size === "sm" ? "min-h-7" : "min-h-9",
          "touch:min-h-11",
          listbox.open && "shadow-[var(--shadow-inset-field),0_0_0_1px_var(--accent)]",
          disabled && "opacity-50",
          className,
        )}
      >
        {chosen.map((option) => (
          <span key={option.value} className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-chip bg-surface pr-0.5 pl-2 text-[12.5px] text-ink shadow-hairline touch:h-8">
            <span className="truncate">{option.label}</span>
            <button
              type="button"
              disabled={disabled}
              aria-label={w(`Remove ${option.label}`, `移除 ${option.label}`, `移除 ${option.label}`)}
              onClick={() => onChange(values.filter((item) => item !== option.value))}
              className="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 hover:text-ink touch:size-7"
            >
              <Icon name="close" size={11} strokeWidth={2.4} />
            </button>
          </span>
        ))}
        <button
          ref={triggerRef}
          type="button"
          id={field.id}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={listbox.open}
          aria-controls={listbox.open ? listboxId : undefined}
          aria-activedescendant={listbox.open && !searchable && listbox.active >= 0 ? `${listboxId}-option-${listbox.active}` : undefined}
          aria-label={aria["aria-label"]}
          aria-describedby={field["aria-describedby"]}
          aria-invalid={field.invalid || undefined}
          aria-required={field.required || undefined}
          disabled={disabled}
          onClick={() => (listbox.open ? listbox.hide() : listbox.show())}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !listbox.open && values.length > 0) {
              event.preventDefault();
              onChange(values.slice(0, -1));
              return;
            }
            listbox.onKeyDown(event);
          }}
          className="flex h-6 min-w-16 flex-1 items-center gap-2 rounded-[6px] pl-1.5 text-left outline-none disabled:cursor-not-allowed touch:h-8"
        >
          <span className="min-w-0 flex-1 truncate text-ink-2">
            {values.length === 0 ? (placeholder ?? w("Select…", "请选择…", "請選擇…")) : ""}
          </span>
          <Icon name="chevronDown" size={13} strokeWidth={2.4} className="shrink-0 text-ink-2" />
        </button>
      </div>
      <ListboxPopup
        listbox={listbox}
        listboxId={listboxId}
        anchorRef={shellRef}
        selected={values}
        multiple
        searchable={searchable}
        searchPlaceholder={searchPlaceholder ?? w("Search", "搜索", "搜尋")}
        emptyLabel={emptyLabel ?? w("No results found", "没有匹配项", "沒有符合項目")}
        label={aria["aria-label"]}
      />
    </>
  );
}
