# Migration Spec — CSS Architecture & Design System

Source: `/home/dev/code/enterprise-agent-platform/main/enterprise-agent-platform/frontend/src/styles.css` (2078 lines, read in full).
Scope: the complete visual/design layer that drives the React refresh. This spec is the single source of truth for tokens, component styles, breakpoints, motion, and the design-quality direction. It does NOT cover JS behavior (see the sibling specs `spec-foundation.md`, `spec-shell-nav.md`, `spec-chat-view.md`, `spec-messages-composer.md`, `spec-admin-core.md`, `spec-knowledge.md`) — but it defines the class contract those components must keep producing.

---

## 0. Stated design intent (header comment, lines 1-7)

> Aesthetic: warm, editorial, calm — in the spirit of Anthropic / Claude. Warm paper surfaces, hazy slate-blue (#7080A0) brand with light-blue support, serif display type for Latin (clean sans for CJK), monospace reserved for genuine machine data. Dual theme via CSS `light-dark()`.

Keep this north star. The refresh should sharpen it, not replace it.

---

## 1. THEMING MECHANISM (critical — read first)

The stylesheet uses the native CSS **`light-dark()`** function for nearly every color token, gated by `color-scheme`. There is NO second block of `--var` overrides for dark mode. Theme switching works as:

- `:root { color-scheme: light dark; }` (line 10) — enables `light-dark()` resolution.
- `:root[data-theme="light"] { color-scheme: light; }` (line 91)
- `:root[data-theme="dark"]  { color-scheme: dark; }` (line 92)

So **the only thing that flips the theme is the `data-theme` attribute on `<html>`** (or absence → follows OS). Every token of the form `light-dark(A, B)` resolves to `A` under `color-scheme: light` and `B` under `color-scheme: dark`.

**React migration note:** Theme is global app state, not CSS-module state. Set `document.documentElement.dataset.theme = 'light' | 'dark'` (or remove for system). A `ThemeProvider`/context that writes the attribute is sufficient — do NOT try to swap stylesheets or duplicate the token block. `light-dark()` has broad modern-browser support (the target is a modern React 19 app, so this is fine to keep). Browser support floor: Chrome/Edge 123+, Safari 17.5+, Firefox 120+. If an older floor is needed, the fallback is to expand each `light-dark(A,B)` into `:root{--x:A}` + `:root[data-theme=dark]{--x:B}` + an `@media (prefers-color-scheme: dark)` block — but prefer to keep `light-dark()`.

---

## 2. DESIGN-TOKEN INVENTORY (`:root`, lines 9-89)

All values below are written `light → dark`. Format is `light-dark(LIGHT, DARK)` in source. Hex anchors from the header: brand ≈ `#7080A0`, paper `#f3efe6` (light bg), espresso `#1c1a17` (dark bg).

### 2.1 Brand & accent (color role)
| Token | Light | Dark | Semantic role |
|---|---|---|---|
| `--brand` | `hsl(220 22% 53%)` | `hsl(222 30% 67%)` | Primary brand slate-blue; avatar gradient base, focus ring color source |
| `--accent` | `hsl(222 24% 41%)` | `hsl(223 40% 77%)` | Link/icon accent, hyperlink color, accent-soft icon color |
| `--accent-hover` | `hsl(223 27% 34%)` | `hsl(223 48% 84%)` | Defined but lightly used (hover accent text) |
| `--accent-solid` | `hsl(222 23% 45%)` | `hsl(222 27% 66%)` | Filled accent surface — primary button bg, streaming caret, agent-work left border, checkbox accent |
| `--accent-solid-h` | `hsl(223 26% 38%)` | `hsl(222 32% 72%)` | Primary button hover bg |
| `--on-accent` | `hsl(44 42% 97%)` | `hsl(35 16% 11%)` | Text/icon ON accent-solid / avatar / chip id |
| `--accent-soft` | `hsl(220 40% 92%)` | `hsl(223 19% 21%)` | Soft tinted surface — active nav, user bubble, active pager, oauth guide, mention agent avatar |
| `--accent-soft-ink` | `hsl(223 29% 35%)` | `hsl(223 44% 83%)` | Text on `--accent-soft` |
| `--accent-line` | `hsl(221 31% 82%)` | `hsl(223 19% 33%)` | Accent-tinted border (chips, active cards, user bubble, oauth dashed) |
| `--sky` | `hsl(208 56% 50%)` | `hsl(206 68% 69%)` | Support light-blue — token usage chart line/area/points only |

### 2.2 Surfaces (surface role)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `hsl(40 30% 92.5%)` (≈#f3efe6) | `hsl(36 9% 9.5%)` (≈#1c1a17) | App canvas / body background; also the default `--bg` local override on `.btn` |
| `--surface` | `hsl(44 48% 97.5%)` | `hsl(36 10% 12.5%)` | Card/input/composer/message-bubble surface, topbar (86% mix) |
| `--surface-2` | `hsl(42 36% 94.5%)` | `hsl(35 11% 15.5%)` | Secondary surface — doc cards, rows, tiles, kbd, nested panels |
| `--surface-3` | `hsl(40 27% 89%)` | `hsl(36 12% 19%)` | Tertiary — hover fills, nav-badge bg, user msg avatar, btn hover |
| `--sidebar` | `hsl(41 28% 90%)` | `hsl(34 13% 8.5%)` | Sidebar background (slightly distinct from `--bg`) |
| `--overlay` | `hsl(35 25% 20% / 0.4)` | `hsl(34 30% 2% / 0.62)` | Mobile scrim backdrop |

### 2.3 Lines / borders (border role)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--line` | `hsl(40 26% 84%)` | `hsl(34 12% 19%)` | Default hairline border, dividers |
| `--line-strong` | `hsl(40 21% 76%)` | `hsl(35 12% 27%)` | Stronger border — inputs, buttons, composer, scrollbar thumb track color |
| `--hairline` | `hsl(40 28% 86% / 0.7)` | `hsl(34 14% 24% / 0.7)` | Translucent hairline (DEFINED but appears UNUSED in the file — verify/remove) |

### 2.4 Text (text role)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--ink` | `hsl(38 9% 13%)` | `hsl(43 28% 89%)` | Primary text |
| `--muted` | `hsl(36 9% 39%)` | `hsl(40 12% 62%)` | Secondary text, descriptions |
| `--faint` | `hsl(36 10% 39%)` | `hsl(40 11% 72%)` | Tertiary — placeholders, timestamps, hints, labels. NOTE comment (lines 40-43): light `--faint` was deliberately darkened to the SAME lightness as `--muted` (both `39%`) to clear WCAG AA 4.5:1. So in light mode `--muted` and `--faint` are nearly identical; the visual hierarchy between them only really exists in dark mode (62% vs 72%). This is a known design smell — see §7. |

### 2.5 Status — ok / warn / danger (color role)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--ok` | `hsl(150 30% 31%)` | `hsl(150 40% 62%)` | Sage success text/icon |
| `--ok-soft` | `hsl(146 33% 90%)` | `hsl(150 28% 14%)` | Success background |
| `--ok-line` | `hsl(148 27% 76%)` | `hsl(150 22% 28%)` | Success border |
| `--dot` | `hsl(150 38% 42%)` | `hsl(150 46% 55%)` | Default status dot fill (online) |
| `--warn` | `hsl(33 64% 33%)` | `hsl(38 76% 62%)` | Ochre warning text/icon |
| `--warn-soft` | `hsl(38 66% 89%)` | `hsl(34 46% 14%)` | Warning bg |
| `--warn-line` | `hsl(36 52% 76%)` | `hsl(34 40% 28%)` | Warning border |
| `--danger` | `hsl(10 55% 42%)` | `hsl(8 72% 71%)` | Brick error text/icon |
| `--danger-soft` | `hsl(12 58% 92%)` | `hsl(8 42% 17%)` | Error bg |
| `--danger-line` | `hsl(11 46% 80%)` | `hsl(8 38% 32%)` | Error border |

### 2.6 Elevation / shadow / ring (shadow role)
| Token | Value | Role |
|---|---|---|
| `--shadow-1` | light `0 1px 2px hsl(34 30% 24% / 0.07)` / dark `0 1px 2px hsl(0 0% 0% / 0.4)` | Resting card/button/message elevation |
| `--shadow-2` | light `0 6px 18px -6px hsl(34 35% 22% / 0.16)` / dark `0 8px 22px -6px hsl(0 0% 0% / 0.55)` | Popovers (mention menu) |
| `--shadow-3` | light `0 20px 50px -14px hsl(34 35% 20% / 0.24)` / dark `0 26px 60px -16px hsl(0 0% 0% / 0.66)` | High overlays — telegram-link panel, toasts, mobile drawer |
| `--ring` | `0 0 0 3px color-mix(in srgb, var(--brand) 35%, transparent)` | Focus ring (box-shadow), theme-agnostic via color-mix on `--brand` |

### 2.7 Geometry — radius (radius role)
| Token | Value | Role |
|---|---|---|
| `--r-xs` | `7px` | btn--sm, kbd, focus-visible radius, small chrome |
| `--r-sm` | `9px` | inputs, buttons, nav items, most rows |
| `--r-md` | `13px` | cards-in-panels, message bubble, doc cards, metric tiles, audit rows |
| `--r-lg` | `18px` | top-level `.card`, composer field, empty icon |
| `--r-pill` | `999px` | avatars, badges, dots, send button, status, chips |

### 2.8 Type (font role)
| Token | Stack | Role |
|---|---|---|
| `--font-display` | `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Source Serif 4", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", serif` | Serif display for headings/titles/brand |
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "Hiragino Sans GB", sans-serif` | UI body default (set on `:root` line 85) |
| `--font-mono` | `ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace` | Machine data — timestamps, IDs, code, metrics, badges, status |

Base typography (body, lines 102-110): `font-size: 14px; line-height: 1.5; letter-spacing: 0;`. `font-synthesis: none; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;` set on `:root`.

### 2.9 Motion (motion role)
| Token | Value | Role |
|---|---|---|
| `--t-fast` | `110ms cubic-bezier(0.4, 0, 0.2, 1)` | Buttons, nav, icon hovers, pager |
| `--t` | `170ms cubic-bezier(0.4, 0, 0.2, 1)` | Inputs, composer field, scrim |

### 2.10 Layout
| Token | Value | Role |
|---|---|---|
| `--sidebar-w` | `264px` | Shell grid first column; mobile drawer caps at `min(86vw, var(--sidebar-w))` |

### 2.11 Runtime-injected custom property (NOT in `:root`)
| Token | Where set | Role |
|---|---|---|
| `--usage-cols` | Set inline on `.usage-table__row` by JS (token usage view) | Column count for `grid-template-columns: repeat(var(--usage-cols), …)`. Implementer MUST keep setting this inline (style prop) on the row element. |

### 2.12 Local token overrides (z-index role + scoped color)
- `.btn { --bg: var(--surface); }` (line 191) then `background: var(--bg)` — a SCOPED redefinition of `--bg` inside buttons. `.btn--primary` does not use it (uses `--accent-solid`). Watch this: a button placed where a parent also reads `--bg` will see the override only inside `.btn`. In React/CSS-modules keep this scoping local.
- **z-index ladder** (no tokens; literal values): sidebar `30`; topbar implicit (sticky-less, in normal flow); telegram-link panel `8`; mention-menu `10`; admin-pager (sticky) `5`; scrim `20`; sidebar (again, `30`); toast-stack `100`. Migration: promote to a `--z-*` token scale (`--z-sticky:5; --z-overlay-panel:8; --z-popover:10; --z-scrim:20; --z-drawer:30; --z-toast:100`).

---

## 3. GLOBAL / RESET STYLES (lines 91-155)

- `* { box-sizing: border-box; }`
- `html, body { width/height 100%; overflow-x: hidden; }`; `body { margin:0; min-width:320px; background:var(--bg); color:var(--ink); font-size:14px; line-height:1.5; }`
- `::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }`
- Scrollbars: `scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent;` + webkit thumb `color-mix(--muted 34%)` (hover 52%), `11px` wide, `3px` transparent border with `background-clip: padding-box`, pill radius.
- Focus model: `:focus { outline:none }`; `:focus-visible { outline:none; box-shadow: var(--ring); border-radius: var(--r-xs); }` — **focus is communicated only via the `--ring` box-shadow, never an outline.** This is keyboard-a11y critical and must be preserved (do not let a CSS reset/library strip it).
- Reset: `h1,h2,h3,p { margin:0 }`; `a { color:var(--accent); text-decoration:none }` / hover underline; `code,kbd,pre,.mono { font-family: var(--font-mono) }`; `.muted { color:var(--muted) }`.
- Utility classes: `.eyebrow` (11px, 600, uppercase, `--faint`), `.kbd` (mono 11px chip with double bottom-border).

---

## 4. COMPONENT-STYLE INVENTORY (grouped by section comment)

For each group: the class contract React must keep emitting, the markup tree it implies, and notable mechanics. (Behavior/handlers/state/API live in sibling specs; here we capture only what the CSS requires of the DOM.)

### 4.1 Form controls (lines 157-257)
- **Native controls** `input, textarea, select`: full-width, `--line-strong` border, `--r-sm`, `--surface` bg, `9px 11px` pad; hover→`--accent-line`; focus-visible→`--accent` border + `--ring`. `textarea { resize: vertical; min-height: 88px; line-height: 1.55 }`. `select` uses two `linear-gradient` background images to draw a custom caret (appearance:none) — **keep the gradient caret**; a React `<Select>` wrapper must not lose `appearance:none` + `padding-right:32px`.
- **`.btn`** + modifiers: base flex, `min-height:36px`, `0 14px`, `--line-strong` border, `--r-sm`, weight `550`, `13.5px`, `:active { transform: translateY(0.5px) }`, `:disabled { opacity .5; pointer-events:none }`. Inner `.btn > span` truncates with ellipsis. Modifiers: `--primary` (accent-solid bg, transparent border, `--on-accent`, shadow-1 + inset highlight), `--ghost` (transparent → surface-3 hover), `--danger` (danger text/line, danger-soft hover), `--lg` (44px), `--block` (100%), `--sm` (30px, r-xs). Icons inside: `.btn svg, .nav__item svg, .channel svg { 17px }`.
- **`.icon-btn`**: 34×34 grid-centered, transparent border, `--muted` → hover surface-3 + `--ink`; svg 18px.
- **`.spin`**: `animation: spin .7s linear infinite` (keyframe `spin` 0→360deg) — loading spinners.

### 4.2 Auth / login (lines 259-323)
- `.auth` two-column grid `1.05fr 1fr`; collapses to 1 col ≤800px (aside hidden).
- `.auth__aside`: layered radial + linear gradients (slate-blue), `::before` extra radial glow, text `hsl(42 30% 90%)`. `.auth__logo` is `filter: brightness(0) invert(1)` (white-out). Decorative; `> *` raised via `position: relative`.
- `.auth__main` centers `.auth__card` (`min(380px,100%)`, gap 16). Card `h1` is display-serif 29px/500. `form` gap 13. `.auth__card .brand__logo { display:none }` on wide (restored ≤800px). 
- **`.field`** family: `.field` (grid gap 6, label `> span` 12.5px/550 muted), `.field--inline` (auto 1fr), `.field-stack` (gap 5), `.field-help` (min-height 16, 12px muted — reserves space to avoid layout shift).
- **`.error`**: hidden when empty; `:not(:empty)` becomes a danger-soft alert box (flex, icon gap 8, danger border). Pattern relies on emptiness — in React render `null` when no error OR keep the `:empty` trick (prefer conditional render but keep the alert styling).

### 4.3 App shell + sidebar (lines 325-453)
- `.shell`: grid `var(--sidebar-w) 1fr`, `height:100vh/100dvh`, `overflow:hidden`. `.shell.is-open` toggles the mobile drawer.
- `.sidebar` (z-30): `--sidebar` bg, right border, flex column. Children: `.sidebar__head` (brand), `.sidebar__scroll` (flex-1 scroll, gap 18 between sections), `.sidebar__foot` (user row, top border).
- `.brand` / `.brand__logo` (20px) / `.brand__eyebrow` (10px uppercase faint).
- `.section-label`: flex space-between, 10.5px/650 uppercase faint (sidebar group headers).
- **`.nav` / `.nav__item` & `.channel`** share one rule (line 370): flex row, gap 10, `8px 10px`, transparent border, `--r-sm`, `--muted`; hover surface-3+ink; `.is-active` → `--accent-soft` bg + `--accent-soft-ink` + weight 600 + a `::before` 3px accent rail at `left:-12px` (relies on `.sidebar__scroll` horizontal padding of 12px — keep that padding or the rail clips). `.nav__item svg` faint→muted on hover→accent when active. `.nav__label` truncates. `.nav__badge` mono pill on surface-3.
- **`.channels` / `.channel`**: `.channel__hash` mono faint (accent when active), `.channel__name` truncates. `.channel-create` inline form (input height 32).
- **User foot**: `.user`, `.avatar` (32×32 pill, gradient `linear-gradient(150deg, --brand, mix(--brand 68% + sky))`, `--on-accent` text, weight 650), `.user__meta` / `.user__name` (truncate) / `.user__role` (10px uppercase faint).

### 4.4 Main column + topbar (lines 455-504)
- `.main`: grid `auto minmax(0,1fr)`, 100dvh, overflow hidden.
- `.topbar`: flex, min-height 60, `10px 20px`, **translucent** bg `color-mix(--surface 86%)` + `backdrop-filter: saturate(140%) blur(8px)`, bottom border. Children: `.topbar__title-wrap` (flex-1), `.topbar__title` (display-serif 17/500, `.hash` mono faint, last span truncates), `.topbar__sub` (12 muted, truncate, HIDDEN ≤520px), `.topbar__actions` (flex gap 4).
- `.private-telegram-trigger`: relative; `.is-active` → accent-soft styled; `.is-linked::after` a 7px green `--ok` dot badge (border `--surface`).
- `.menu-btn { display:none }` (shown ≤800px as `inline-grid`). `.scrim` is a real `<button>` reset to no chrome, `display:none` desktop (shown as fixed backdrop ≤800px) — keyboard-dismissable drawer.
- `.content`: `min-width/height:0; overflow:hidden; position:relative; display:grid`.
- **View entrance**: `@keyframes view-in` (opacity 0 + translateY 6px → none); `.view-enter { animation: view-in .24s cubic-bezier(.22,1,.36,1) both }` — applied only when the view actually changes.

### 4.5 Chat — messages, bubbles, attachments, chips (lines 506-661)
- `.chat`: grid `1fr auto` (messages scroll region + composer).
- **`.telegram-link`** (z-8, absolute top-right popover): `min(520px,…)`, `--surface-2`, `--shadow-3`, grid gap 10. Sub-parts: `__header` (space-between), `__meta`, `__title` (weight 650), `__sub` (12 muted), `__form` (grid `1fr 1fr auto`, collapses to 1col ≤940px), `__actions` (right-aligned), `__close` (30×30).
- **`.messages`**: scroll container, `22px 20px 8px`, flex column gap 16. `.messages__inner` caps width `min(860px,100%)` centered.
- **`.msg`**: flex row gap 12, `max-width:88%` (→100% ≤800px). `.msg--user` reverses row + right-aligns. `.msg__avatar` 32×32, radius 9px (NOT a token), mono 12/650; agent variant accent-soft, user variant surface-3.
- **`.msg__bubble`**: bordered surface card `--r-md` shadow-1; **agent variant is borderless/transparent** (`background:transparent; border:none; box-shadow:none; padding:1px 0 0`); user variant accent-soft + accent-line.
- `.msg__meta` (baseline flex wrap), `.msg__name` (12.5/650), `.msg__time` (mono 10.5 faint), `.msg__pending` (11 muted), `.msg--pending { opacity .72 }`.
- `.msg__body`: `white-space: pre-wrap; word-break: break-word; line-height:1.66; font-size:14.5px`.
- **Streaming caret**: `.msg--streaming .msg__body::after` — a 7px×1.15em accent-solid block, `animation: blink 1s infinite both` (keyframe at line 750).
- **Attachments**: `.msg-attachments` grid gap 8. `.msg-attachment--image` (`min(360px)`, img `max-height:320px object-fit:contain` bordered). `.msg-attachment--file` grid `28px 1fr 18px` row with `.msg-attachment__fileicon` (accent-soft tile) + `__meta strong` (truncate). `__caption`/`__meta span` 11.5 muted.
- **`.chip`** (suggestions): pill, accent-line border, accent-soft-ink, surface bg, 11.5px; `.chip__id` mono on accent-solid. `.msg__suggest` is a dashed-top flex-wrap row.

### 4.6 Agent work / typing (lines 663-750)
- **`.typing` / `.typing__dots`**: three `i` dots 6px, `animation: blink 1.2s infinite both` with `:nth-child(2)` delay .2s, `(3)` .4s.
- **`.agent-work`** (collapsible `<details>` styled): `min(680px)`, left 3px accent-solid rail, surface, shadow-1, overflow hidden. States: `--active` (accent-soft mix bg, accent-line), `--complete` (surface, line border, line-strong rail). `.agent-work__summary` is the `<summary>` (min-height 42, flex, cursor pointer, `list-style:none` + `::-webkit-details-marker{display:none}` to kill the native triangle). `__done` (22px pill icon), `__main` (grid), `__title` (12.5/650), `__step` (12 muted truncate). `.agent-work__log` mono 12 region with top border + tinted bg; `.agent-work__line` muted, **last child → `--ink`** (highlights latest line).
- `.agent-status` (flex 13 muted min-height 32), `.agent-status__queue` (12 faint). `.typing-line` (flex, 12.5 muted, `padding-left:44px` to align under avatar).
- **`@keyframes blink`** (line 750): `0/60/100% { opacity:.25; translateY(0) } 30% { opacity:1; translateY(-2px) }` — shared by typing dots AND streaming caret.

### 4.7 Composer (lines 752-888)
- `.composer`: top border, `--surface`, `14px 20px calc(16px + env(safe-area-inset-bottom))`. `.composer__wrap` caps `min(860px)` centered.
- **`.composer__field`**: relative flex `align-items:flex-end` gap 8, `--line-strong` border, **`--r-lg`** pill-ish, `7px 7px 7px 15px`; `:focus-within { border:--accent; box-shadow:--ring }` (focus-within is how the whole field lights up). Inner `textarea` is chromeless (border 0, transparent, `height:35px`, `min-height:24px`, `max-height:200px`, `resize:none`, `overflow-y:hidden`, transitions height) — **autosize is JS-driven height; `.is-scrollable` adds `overflow-y:auto`** when content exceeds max. `textarea:focus-visible { box-shadow:none }` (ring lives on the wrapper).
- `.composer__file-input { display:none }` (hidden native file input). `.composer__attach` (34) and `.composer__send` (36 pill) buttons.
- `.composer__hint` (flex-wrap 11.5 faint). 
- **`.composer-files` / `.composer-file`**: pending-attachment chips grid `18px 1fr auto 24px` (icon/name/size/remove), `max-width:260px` (→100% ≤520px). `__icon` accent, `__name` truncate 12/600, `__size` 11 faint, `__remove` 24×24.
- **`.mention-menu`** (z-10 popover above field): `position:absolute; left:12px; right:52px; bottom:calc(100%+8px)`, `max-height:260px` scroll, surface, shadow-2; `[hidden] { display:none }`. **`.mention-option`** rows grid `30px 1fr auto`, `min-height:44px` (good touch target); `.is-active` (keyboard nav) and `:hover` share surface-2 highlight. `__avatar` (28px, `--agent` accent-soft variant), `__main` grid, `__label` (650 truncate), `__meta` (mono 11.5 muted), `__desc` (faint truncate, max-width 180). ≤520px the menu goes `left:0; right:0` full-bleed.

### 4.8 Panels — knowledge / settings shell (lines 890-1002)
- `.panel` (scroll region `22px 20px 40px`), `.panel__inner` (`min(1080px)` centered grid gap 16), `.panel__header` (flex end space-between; wraps ≤940px; `h2` display-serif 18/500).
- **`.card`** (top-level): surface, `--line`, `--r-lg`, `18px` pad, grid gap 14, shadow-1. `.card__head` (flex start space-between), `.card__title` (display-serif 15/600, svg 17 muted, span truncate), `.card__desc` (12.5 muted), `.card form` (grid gap 12).
- `.list` (grid gap 9), `.divider` (1px `--line` hr).

### 4.9 Admin paging (lines 898-981)
- **`.admin-pager`** (sticky `top:0` z-5): flex-wrap tab bar, translucent surface + blur, shadow-1. `.admin-pager__item` (min-height 42, weight 600, muted; hover surface-2; `.is-active` accent-soft + accent-line). `.admin-pager__badge` (mono pill count). **Mobile ≤800px**: pager becomes a horizontal scroll-snap strip (`flex-nowrap; overflow-x:auto; scroll-snap-type:x proximity; scrollbar-width:none`), items `scroll-snap-align:start`.
- `.admin-page` (grid gap 14), `.admin-page__head` (flex end space-between; `h2` display-serif 19/500; `p` max-width 660 muted 12.5; becomes a 2-col grid ≤800px, 1-col ≤360px). `.admin-page__content` (grid gap 16).

### 4.10 Knowledge (lines 1004-1035)
- `.kb-grid` two columns `minmax(0,380px) minmax(0,1fr)` (1col ≤940px or via `.kb-grid--single`).
- `.search-field` (relative; leading svg absolute left 11, input `padding-left:34`, `__clear` button right). `.list__note` (space-between 12.5 muted).
- **`.doc-card`**: surface-2, `--r-md`, 13px, grid gap 5; hover → accent-line + shadow-1. `__title` (flex, accent svg 15, truncate span), `__summary` (2-line clamp via `-webkit-line-clamp:2`), `__actions` (flex-wrap).
- **`.doc-viewer`**: surface-2 bordered `--r-md`; `__bar` (space-between header), `pre` (mono-ish? actually inherits; `12.5/1.6`, `white-space:pre-wrap`, `max-height:360 overflow:auto`).

### 4.11 Settings rows — accounts (lines 1037-1091)
- `.account-admin` (gap 16). `.account-create` (surface-2 bordered box) + `__grid` (3 equal cols → 1col ≤940px).
- `.account-list` (grid gap 10). `.account-row` (surface-2 box) with `__head` (flex space-between), `__identity` (avatar + name/email stack, `strong` truncate 13.5, `span` 12 muted), `__grid` (3 cols → 1col ≤940px), `__active` (min-height 100%).

### 4.12 Token usage (lines 1093-1278)
- `.token-usage` (grid gap 16). `.token-usage__overview`. `.token-usage__filters` (right-aligned flex-wrap, `.field` width 130 → flexes ≤940px). `.token-usage__columns` (2 cols → 1col ≤940px).
- **`.metric-grid`** auto-fit `minmax(145px,1fr)` gap 10; `--compact` variant (margin-top 14, tiles min-height 64, strong 16). `.metric-tile` (surface-2 box, min-height 74): `span` (12 muted label), `strong` (**mono 21px** big number, `overflow-wrap:anywhere`), `small` (11.5 faint). Mobile: tiles shrink (≤520px minmax 126, strong 18).
- **`.token-curve`** (inline SVG sparkline): `__head` (label/value), `__svg` (height 190, `overflow:visible`), `__axis` (stroke line-strong), `__area` (fill `--sky` 16% mix), `__line` (stroke `--sky` width 3 round caps), `__point` (surface fill, sky stroke). `__labels` 7-col grid; `__label` (centered 11.5 muted, `strong` mono 12 ink). **These classes style an SVG the JS builds** — React should render the same SVG element tree with these classes; chart math stays in JS.
- **`.usage-table`** (CSS-grid faux table): outer grid uses `background:var(--line)` + `gap:1px` so the gaps render as hairlines (a grid-gap-as-border trick — keep it). `.usage-table__row` grid `repeat(var(--usage-cols), minmax(120px,1fr))`, `min-width: max(900px,100%)` (horizontal scroll). `__row > *` cells surface bg pad `10px 11px` wrap-anywhere. `__head` cells surface-2 muted 650. `.usage-table strong` mono 700. `.usage-user` (name/email stack, `small` 11.5 muted). Mobile shrinks min-widths (560 ≤800px, 500 ≤360px) and col min from 120→82.

### 4.13 Message audit (lines 1280-1409)
- `.audit-grid` (gap 16). `.audit-tools` (3-col → 1col ≤940px) of `.audit-tool` (surface-2 boxes, align-content end). `.audit-tool--compact .field { margin:0 }`.
- `.audit-list` (grid gap 8, `max-height:520 overflow:auto` → unbounded ≤520px). `.audit-message` grid `1fr auto` with `__meta` (flex-wrap faint 11.5, `strong` ink), `__body` (col 1, pre-wrap line 1.58), `__actions` (col 2 spanning both rows, danger icon-btn). Mobile `audit-message` → `1fr 34px`.
- **`.audit-private`** two-col `minmax(220px,300px) 1fr` (→1col ≤940px): `.audit-conversations` (scroll list max-height 560) of `.audit-conversation` (grid `32px 1fr auto`, avatar radius 8, hover accent-line, `.is-active` accent-soft); `.audit-private__messages`. `.audit-subhead` (surface-2 header row, `span:not(.status)` muted).

### 4.14 Secret / runtime rows (lines 1411-1442)
- `.secret-row` grid `1fr auto` surface-2 box: `__key` (svg faint 15 + `__name` mono 12.5/600 wrap-anywhere), `__val` (mono 11.5 faint), nested `form` spans full width (input height 32). ≤800px → 1col, form wraps.
- `.runtime-row` flex surface-2 box: `__main` (title + `__name` 13.5/600 + `__detail` mono 11.5 muted), `__actions` (flex-wrap right). ≤800px stacks, actions full-width.

### 4.15 Status badge + dot (lines 1444-1480)
- **`.status`** pill: inline-flex, height 22, `--r-pill`, `--line` border, **mono 11/600**, muted text, surface bg, `text-transform:lowercase`, truncates. Variants `--ok` (ok colors) / `--warn` (warn colors). Contains a `.dot` (forced 7px inside status).
- **`.dot`**: 8px circle `--dot`. Variants `--warn`, `--off` (`--faint`). `.dot--pulse::after` is a ping ring (`@keyframes pulse`: scale 1→3.2, opacity .6→0, 1.8s). Note pulse inherits the dot's `background`.

### 4.16 OAuth (lines 1482-1541)
- `.oauth-transfer` (right flex-wrap). `.oauth-grid` auto-fill `minmax(min(300px,100%),1fr)`. `.oauth-card` (surface-2 box, gap 12); `.is-active` → accent-line + `box-shadow:0 0 0 1px accent-line` (ring). `__head` / `__id` / `__logo` (34px tile bordered) / `__label` (13.5/600 wrap) / `__model` (mono 11 muted). `.oauth-meta`, `.oauth-actions` (flex-wrap).
- `.oauth-error` (danger alert with icon). `.oauth-guide` (accent-soft box; `.complete` → ok colors). `.oauth-line` (flex-wrap, `> span` label min-width 64). **`.oauth-code`** (mono **24px**/700 centered dashed-accent box — the device code; shrinks to 20px ≤360px).

### 4.17 Config forms (lines 1543-1700)
- `.config-form` (max 720) / `.config-grid` (2col → 1col ≤940px; `.field--full` spans). `.security-config` (max 860). `.security-status` auto-fit `minmax(230px,1fr)` of `__row` (flex space-between surface-2; `.status` capped 68% width). 
- `.config-software` (max none). `.config-sections` (flex-wrap chips). `.config-fields-form` / `.raw-config-form` (grid gap 12). `.config-groups` of `.config-group` (`<details>` surface-2, overflow hidden): `summary` (min-height 40, 13/600), `__body` (auto-fit `minmax(min(260px,100%),1fr)`). `.config-field` (grid gap 6) with `__label` (flex baseline space-between wrap; `strong` 12.5/600; `code` faint 11 right-aligned, left ≤520px), `__meta`, `__source` (accent-soft pill 10.5/650). `config-field textarea, .raw-config` (mono 12, min-height 88; raw 320). 
- `.config-warning` (warn alert), `.notice` (surface-2 callout; `--warn` variant), `.config-preview` (mono pre, max-height 180 scroll). `.check-row` (surface-2 box, `input` 18px `accent-color:var(--accent-solid)`, `__text` strong+span). `.form-actions` (flex-wrap gap 9).

### 4.18 Empty state (lines 1702-1722)
- `.empty` (`margin:auto`, centered grid, `48px 24px`, max 380): `__icon` (56px `--r-lg` surface-2 tile, accent, svg 26), `h3` (display-serif 17/500), `p` (13 muted).

### 4.19 Toasts (lines 1724-1762)
- **`.toast-stack`**: `position:fixed; z-100; right/bottom: calc(18px + safe-area)`, flex column gap 10, `max-width: min(380px, 100vw-36px)`, `pointer-events:none` (so the empty stack doesn't block).
- **`.toast`**: `pointer-events:auto`, flex, surface, line-strong border, shadow-3, `animation: toast-in .26s cubic-bezier(.22,1,.36,1) both`. `.is-leaving { animation: toast-out .2s ease forwards }`. Variants `--error` / `--ok` add a 3px left border + colored `__icon`. `__body` (13 wrap-anywhere), `__title` (600), `__msg` (muted), `__close` (offset top-right). Keyframes `toast-in` (translateX 16 + scale .98 → none) / `toast-out` (→ translateX 16, opacity 0).
- **Migration**: the `.is-leaving` exit animation is a manual leave-class pattern. In React, drive exit with the same keyframes via an exit state (e.g. a small `useToast` that adds `is-leaving` then unmounts after 200ms, or a transition lib). Preserve `pointer-events` on stack vs toast.

---

## 5. RESPONSIVE BREAKPOINTS (lines 1764-2066)

Mobile-styles are layered max-width queries (desktop-first). Cumulative behavior — smaller queries assume the larger ones still apply.

### `@media (max-width: 940px)` — tablet
- Collapse all multi-col grids to 1 col: `.kb-grid, .config-grid, .account-create__grid, .account-row__grid, .token-usage__columns, .audit-tools, .audit-private, .telegram-link__form`.
- `.telegram-link` reflows (right 14, header/actions left-align).
- `.panel__header, .card__head` → `align-items:flex-start; flex-wrap:wrap`; last child max-width 100%.
- `.token-usage__filters` left-align; `.field` grows (`flex:1 1 130px`).

### `@media (max-width: 800px)` — phone / drawer mode (the big one)
- `.auth` → 1col, aside hidden, card logo restored.
- **`.shell` → 1col**; `.menu-btn` shown (`inline-grid`).
- **Sidebar becomes a fixed off-canvas drawer**: `position:fixed; inset:0 auto 0 0; width:min(86vw,var(--sidebar-w)); transform:translateX(-102%); transition .26s`; `.shell.is-open .sidebar { transform:none }`. `.scrim` becomes a fixed `--overlay` backdrop (`opacity/visibility` toggled by `.shell.is-open`).
- Topbar tightens; `.messages, .composer` side pad 14; `.panel` 16/14/32; `.msg { max-width:100% }`.
- **Admin pager → horizontal scroll-snap strip** (see §4.9); items min-height 38.
- `.admin-page__head` → grid `1fr auto`. `.card` pad 15. `.token-usage__overview .card__head` → grid. `.usage-table__row` min-width 560 / col min 82. `.audit-message` → `1fr 34px`. `.secret-row` 1col, form wraps. `.runtime-row` stacks, actions full-width. `.oauth-transfer/.oauth-actions/.form-actions` left-align.

### `@media (max-width: 520px)` — small phone
- Auth main pad 22/18. Topbar 56 min, `.topbar__sub { display:none }`. Messages top pad 16. `.msg` gap 9, avatar 28 radius 8, bubble 10/11. Composer tightens (field gap 5, `--r-md`, attach/send 32/34). `.composer-file` full-width. `.mention-menu` full-bleed (`left:0;right:0`). Panels/cards tighten; `.card` → `--r-md`. `.account-create/.account-row/.audit-tool/.oauth-card` pad 11; heads wrap. `.metric-grid` minmax 126, tiles min-height 66/strong 18. `.audit-list` unbounded. Config groups/fields tighten; `__label` stacks, `code` left-align; `.raw-config` 220.

### `@media (max-width: 360px)` — tiny
- `.btn` min-width 0, side pad 10. `.icon-btn` 32. Admin pager negative inline margin + items 36/9. `.admin-page__head` 1col, `.status` justify start. `.card` pad 10. `.usage-table__row` min-width 500. `.oauth-code` 20px.

### `@media (prefers-reduced-motion: reduce)` (lines 2071-2077)
- Nukes all animation/transition/scroll-behavior to `0.001ms`/`auto !important`. **Keep this.** React components must not introduce JS-driven animations that ignore it (gate framer-motion etc. on `useReducedMotion`).

---

## 6. ANIMATIONS / TRANSITIONS (consolidated)

| Name / where | Definition | Used by |
|---|---|---|
| `@keyframes spin` | `to { rotate 360 }`, 0.7s linear infinite | `.spin` loaders |
| `@keyframes view-in` | opacity 0 + translateY 6 → none, 0.24s `cubic-bezier(.22,1,.36,1)` | `.view-enter` on view change |
| `@keyframes blink` | opacity .25/translateY0 → opacity1/translateY-2 at 30%, infinite | typing dots (1.2s), streaming caret (1s) |
| `@keyframes pulse` | scale 1→3.2, opacity .6→0, 1.8s ease-out | `.dot--pulse::after` |
| `@keyframes toast-in` | translateX16+scale.98 → none, 0.26s | `.toast` enter |
| `@keyframes toast-out` | → translateX16 opacity0, 0.2s | `.toast.is-leaving` |
| Drawer slide | `transform .26s cubic-bezier(.22,1,.36,1)` | mobile `.sidebar` |
| Scrim fade | `opacity var(--t)` | mobile `.scrim` |
| Token transitions | `--t-fast` (110ms) buttons/nav; `--t` (170ms) inputs/composer | throughout |

Two easing curves in use: the Material standard `cubic-bezier(0.4,0,0.2,1)` (tokenized in `--t`/`--t-fast`) and an expressive `cubic-bezier(0.22,1,0.36,1)` (NOT tokenized — used for view-in, toast-in, drawer). **Migration: tokenize the second curve as `--ease-emphasized` so it stops being copy-pasted.**

---

## 7. DESIGN-QUALITY ASSESSMENT & REFRESH OPPORTUNITIES

The palette, warmth, serif/mono split, and `light-dark()` foundation are genuinely good and should be kept. The weaknesses are systemic consistency issues, not the color story.

### 7.1 Type scale is fragmented (highest-impact fix)
Font sizes in the file (sampled): `10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 17, 18, 19, 21, 24, 29` px — ~19 distinct sizes, many separated by 0.5px which is imperceptible and just noise. Weights span `500, 550, 600, 650, 700` (550/650 are synthetic-ish and depend on variable fonts; with `font-synthesis:none` they may snap to 500/600/700 on systems without the weight). 
- **Refresh:** define a real modular scale as tokens, e.g. `--text-2xs:11px; --text-xs:12px; --text-sm:13px; --text-base:14px; --text-md:15px; --text-lg:17px; --text-xl:19px; --text-2xl:22px; --text-3xl:29px` and a weight set `--fw-normal:450; --fw-medium:550; --fw-semibold:650`. Collapse the 0.5px variants onto the nearest step. Keep the serif-display vs sans-vs-mono role split exactly. Add `letter-spacing` refinement for the serif display sizes (slight negative tracking at 24/29px reads more editorial).

### 7.2 Spacing is ad-hoc
Paddings/gaps use `1,2,3,4,5,6,7,8,9,10,11,12,13,14,16,18,20,22,…` — no scale. `9px 11px`, `8px 10px`, `11px 13px`, `13px`, `14px` all coexist for similar row paddings.
- **Refresh:** adopt a 4px base scale tokenized as `--space-1…--space-12` (4/8/12/16/20/24…) plus a couple of half-steps (2,6,10) for dense controls. Map existing values to the nearest step. This removes the slightly-off rhythm without a visible redesign.

### 7.3 Radius/border bypasses
Hardcoded radii leak past the tokens: `9px` (`.msg__avatar`, `.oauth-card__logo`), `8px` (mention/audit avatars, `.msg__avatar` ≤520), `7px` (fileicon). Border `1px` literal everywhere.
- **Refresh:** route avatar/tile radii through a token (`--r-avatar`), and consider a `--border:1px` (or hairline via `0.5px`/device-pixel) token. Small, mechanical.

### 7.4 `--muted` vs `--faint` collapse in light mode
Both are `…39%` lightness in light theme (deliberate, for AA), so the intended 3-tier text hierarchy (ink/muted/faint) flattens to 2 tiers in light mode. Timestamps, hints, and labels look identical to body-secondary.
- **Refresh:** re-introduce a perceptible faint tier in light mode by shifting hue/chroma instead of just lightness (e.g. a slightly warmer, lower-chroma faint that still passes AA against `--surface`/`--bg`), or by reserving `--faint` for non-text decoration only and giving small text a guaranteed-AA `--muted`. Re-run contrast (see 7.6).

### 7.5 Elevation/depth is shallow & generic
Three soft shadows, but cards mostly sit on shadow-1 (1px) → the UI reads flat/CSS-default. The accent-soft fills + 1px lines do most of the work.
- **Refresh:** introduce a more deliberate elevation system: pair each shadow with a subtle top inset highlight (already done on `.btn--primary` via `inset 0 1px 0 hsl(0 0% 100%/.14)` — generalize it to cards in light mode) and a faint colored ambient shadow tinted toward the warm hue (already warm-tinted — push it slightly). Use `--shadow-2` for resting cards on key surfaces (knowledge/admin) to create hierarchy vs nested surface-2 boxes. Keep dark-mode shadows restrained (they already are).

### 7.6 Contrast / a11y gaps to verify
- Focus is box-shadow-only (`--ring`). Good that it exists, but on elements with `overflow:hidden` ancestors the ring can be clipped — audit `.composer__field` children, sidebar items inside `overflow-y:auto`, and table cells. Ensure rings aren't visually cut.
- `.status` text is `--muted` mono 11px on `--surface` — small + low contrast; verify AA, bump to `--ink` or enlarge.
- `.msg__time` / `.chip` / `.metric-tile small` use `--faint` at 10.5–11.5px — borderline; verify against their actual backgrounds (chip sits on `--surface`, label on `--accent-solid` for `.chip__id` which is fine).
- `select` custom caret is decorative gradient only — fine, but ensure the native focus ring still appears (it does via `:focus-visible`).
- Decorative `.auth__aside` text `hsl(42 30% 90%)` on the gradient — verify AA for the welcome copy.
- No `prefers-contrast` support — consider a `@media (prefers-contrast: more)` that swaps `--line`→`--line-strong` and bumps muted/faint toward ink.

### 7.7 Distinctiveness opportunities (keep warm paper / espresso)
Without changing the `#f3efe6` / `#1c1a17` anchors:
- **Texture/grain:** a very subtle paper grain or noise overlay on `--bg` (1–2% opacity, `background-image`) would make the "warm paper" intent literal and differentiate from generic flat themes. Gate behind reduced-data/perf checks.
- **Editorial accents:** lean into the serif — larger serif section headers with a hairline rule, drop the synthetic 550/650 weights for true display weights. The brand already wants "editorial."
- **Refined accent usage:** the slate-blue accent is currently mostly in soft fills + active rails. A single confident accent moment (primary button, send button) is good; resist spreading accent everywhere. The `--sky` support color is under-used (charts only) — could appear in subtle data viz / link hovers for a second-color rhythm.
- **Motion polish:** standardize on the expressive `cubic-bezier(.22,1,.36,1)` for entrances/overlays (tokenize it), keep Material curve for micro-hovers. Add tasteful stagger only where it doesn't fight reduced-motion.
- **Corner language:** the radius ladder (7/9/13/18) is a bit arbitrary; a cleaner ratio (8/12/16/20) or (6/10/14/18) reads more intentional.

### 7.8 Dead/loose ends to clean up
- `--hairline` token appears defined but unused — confirm and remove or actually use it for translucent dividers.
- `--accent-hover` is barely referenced — confirm usage; consolidate if dead.
- The `.btn { --bg: ... }` scoped redefinition of a global token name is a footgun (shadows the surface `--bg`); rename to `--btn-bg`.

---

## 8. HOW TO STRUCTURE CSS FOR THE REACT APP

**Constraint:** the build outputs a single `styles.css` (the platform serves generated assets from `enterprise_agent_platform/static/`; `npm run build` produces the bundle). So whatever authoring strategy is chosen must compile to one stylesheet without per-component runtime style injection bloat.

**Recommendation (hybrid, in priority order):**

1. **Keep ONE global token + base layer** (`tokens.css` / `base.css`): the entire `:root` block (§2), `light-dark()` theming, reset, scrollbars, focus model, typography utilities. This MUST stay global and load first — it is the design system contract every component depends on. Do NOT scope tokens into modules. Use `@layer tokens, base, components, utilities` to make cascade order explicit and safe against third-party CSS.

2. **Co-locate component styles as CSS Modules** (`*.module.css`) per React component for everything in §4 (buttons, cards, composer, messages, admin pager, etc.). Modules give local class names + dead-code elimination, all of which Vite concatenates into the single output `styles.css`. Components reference tokens via `var(--…)` from the global layer. Keep the public class names that JS/3rd-party or tests rely on (e.g. status variants) only where there's an external contract; otherwise modules can rename freely.
   - Caveat: a few classes are toggled by app/global state (`.is-active`, `.is-open`, `.is-linked`, `.is-leaving`, `.view-enter`, `--usage-cols`). Keep these as explicit state-driven class/style props in React (e.g. `className={cx(s.navItem, active && s.isActive)}`), and keep `--usage-cols` set via the `style` prop on the row.

3. **Avoid CSS-in-JS runtime libraries** (styled-components/emotion runtime) — they fight the "single static styles.css" build goal and add hydration cost. If a CSS-in-JS DX is desired, use a **zero-runtime** option (vanilla-extract or Panda/Linaria) that compiles to a static stylesheet at build time and can also generate the token contract type-safely. Vanilla-extract pairs especially well with `light-dark()`/theme contracts.

4. **Tokens as the seam for the refresh:** implement §7 by editing ONLY the token layer + adding scale tokens (type/space/z/ease). Because components consume tokens, the visual refresh becomes a token change, not a component rewrite. This is the safest path to "refresh the look without losing behavior."

5. **Theme switching** stays a single `data-theme` attribute write at the root (§1) via a `ThemeContext`; no module needs to know about themes.

**Net:** `@layer`-ordered global `tokens.css` + `base.css`, then co-located `*.module.css` per component, optionally migrated to vanilla-extract later. Single compiled `styles.css` preserved. Theme + state classes driven by React props; tokens are the refresh lever.

---

## 9. CLASS CONTRACT CHECKLIST (must keep emitting)

The implementer must keep producing these state/structural hooks so existing behavior + this stylesheet keep matching (grouped):
- Layout/shell: `.shell`, `.shell.is-open`, `.sidebar`, `.scrim`, `.main`, `.topbar`, `.content`, `.view-enter`, `.menu-btn`.
- Nav: `.nav__item`/`.channel` + `.is-active`; `.section-label`, `.nav__badge`.
- Chat: `.msg`, `.msg--user/--agent/--pending/--streaming/--activity`, `.msg__bubble/__avatar/__meta/__name/__time/__body/__suggest`, `.chip`/`.chip__id`, `.agent-work` + `--active/--complete`, `.typing`, `.typing-line`.
- Composer: `.composer__field` (+ `:focus-within`), `textarea.is-scrollable`, `.composer-file`, `.mention-menu[hidden]`, `.mention-option.is-active`.
- Admin/data: `.admin-pager__item.is-active`, `.card`, `.usage-table__row` (+ inline `--usage-cols`), `.metric-tile`, `.token-curve*` SVG classes, `.audit-conversation.is-active`.
- Status/feedback: `.status--ok/--warn`, `.dot--warn/--off/--pulse`, `.toast--error/--ok`, `.toast.is-leaving`, `.empty`, `.error:not(:empty)`, `.oauth-card.is-active`, `.oauth-guide.complete`.

---

## 10. Cross-references
- Foundation/theme bootstrap & `h()` renderer: `spec-foundation.md`.
- Shell/sidebar/topbar behavior: `spec-shell-nav.md`.
- Chat rendering & streaming behavior: `spec-chat-view.md`, `spec-messages-composer.md`.
- Admin/usage/audit/oauth/config behavior: `spec-admin-core.md`.
- Knowledge view behavior: `spec-knowledge.md`.
