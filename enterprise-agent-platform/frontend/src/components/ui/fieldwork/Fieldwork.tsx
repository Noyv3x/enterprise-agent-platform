import { Provider as MotionProvider } from '@rc-component/motion';
import { App, Button, ConfigProvider, Drawer, theme as antTheme } from 'antd';
import type { ConfigProviderProps, ThemeConfig } from 'antd';
import { createContext, useContext, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type BrandIdentity = { productName: string; logoUrl?: string | null };
export type FieldworkMode = 'light' | 'dark';

const palettes = {
  light: {
    canvas: '#f3f4f6', surface: '#fdfdfd', inset: '#ecedef', ink: '#25272b',
    muted: '#60656d', faint: '#646b75', line: '#dce0e5', strongLine: '#adb3bd',
    success: '#466343', warning: '#805c22', danger: '#a44436', info: '#3d617c',
  },
  dark: {
    canvas: '#1d1f22', surface: '#25272b', inset: '#303338', ink: '#edeef0',
    muted: '#b7bbc3', faint: '#a7adb7', line: '#41454c', strongLine: '#646c77',
    success: '#b1c9a1', warning: '#e5c486', danger: '#f0aaa0', info: '#aecbdf',
  },
} as const;
const fallbackBrand = '#52606d';
const brandForeground = { light: '#fdfefe', dark: '#030405' } as const;
const bodyFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SurfaceContext = createContext<(() => HTMLElement) | undefined>(undefined);
const NavigationCloseContext = createContext<(() => void) | undefined>(undefined);

function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}
function luminance(values: number[]): number {
  const linear = values.map((value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function accessibleAccent(raw: string, surface: string, ink: string, inset: string): { accent: string; accentWash: string } {
  const base = rgb(raw);
  const target = rgb(ink);
  const surfaceRgb = rgb(surface);
  const surfaceLuminance = luminance(surfaceRgb);
  const insetLuminance = luminance(rgb(inset));
  const contrast = (foreground: number, background: number) =>
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  for (let step = 0; step <= 100; step += 1) {
    const mixed = base.map((value, index) => Math.round(value + (target[index]! - value) * step / 100));
    const wash = mixed.map((value, index) => Math.round(value * 0.11 + surfaceRgb[index]! * 0.89));
    const foreground = luminance(mixed);
    if (
      contrast(foreground, surfaceLuminance) >= 4.5 &&
      contrast(foreground, luminance(wash)) >= 4.5 &&
      contrast(foreground, insetLuminance) >= 4.5
    ) {
      return {
        accent: `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`,
        accentWash: `#${wash.map((value) => value.toString(16).padStart(2, '0')).join('')}`,
      };
    }
  }
  throw new Error('Fieldwork palette does not provide an accessible accent');
}

/** Use this container for controller-owned Ant Modal/Drawer portals to inherit theme variables. */
export function useFieldworkContainer(): (() => HTMLElement) | undefined {
  return useContext(SurfaceContext);
}

export interface FieldworkProviderProps {
  mode: FieldworkMode;
  primaryColor?: string;
  locale?: ConfigProviderProps['locale'];
  prefixCls?: string;
  motion?: boolean;
  touch?: boolean;
  children: ReactNode;
}
export function FieldworkProvider({ mode, primaryColor, locale, prefixCls, motion = true, touch = false, children }: FieldworkProviderProps) {
  const root = useRef<HTMLDivElement>(null);
  const getContainer = useMemo(() => () => root.current ?? document.body, []);
  const design = useMemo(() => {
    const palette = palettes[mode];
    const brandRaw = primaryColor && /^#[\da-f]{6}$/i.test(primaryColor) ? primaryColor : fallbackBrand;
    const { accent, accentWash } = accessibleAccent(brandRaw, palette.surface, palette.ink, palette.inset);
    const brandLuminance = luminance(rgb(brandRaw));
    const lightContrast = (luminance(rgb(brandForeground.light)) + 0.05) / (brandLuminance + 0.05);
    const darkContrast = (brandLuminance + 0.05) / (luminance(rgb(brandForeground.dark)) + 0.05);
    const onBrand = lightContrast >= darkContrast ? brandForeground.light : brandForeground.dark;
    const variables = Object.fromEntries(Object.entries({ ...palette, brandRaw, accent, accentWash, onBrand }).map(([key, value]) => [
      `--wf-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value,
    ])) as CSSProperties;
    const config: ThemeConfig = {
      algorithm: mode === 'dark' ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
      token: {
        colorPrimary: brandRaw, colorPrimaryText: accent, colorLink: accent, colorTextLightSolid: onBrand,
        colorBgBase: palette.surface, colorBgLayout: palette.canvas, colorBgContainer: palette.surface,
        colorBgElevated: palette.surface, colorFillAlter: palette.inset,
        colorText: palette.ink, colorTextSecondary: palette.muted, colorTextTertiary: palette.faint,
        colorBorder: palette.strongLine, colorBorderSecondary: palette.line,
        colorSuccess: palette.success, colorWarning: palette.warning, colorError: palette.danger,
        colorInfo: palette.info, borderRadius: 8, borderRadiusSM: 4, borderRadiusLG: 12,
        fontFamily: bodyFont, fontSize: 14, fontSizeSM: 13, fontSizeLG: 14,
        fontSizeHeading1: 20, fontSizeHeading2: 18, fontSizeHeading3: 16, fontSizeHeading4: 14, fontSizeHeading5: 14,
        controlHeight: touch ? 44 : 36, controlHeightLG: touch ? 44 : 40, controlHeightSM: touch ? 44 : 36,
        lineWidth: 1, padding: 16, paddingLG: 24, paddingSM: 12,
        motionDurationFast: '0.14s', motionDurationMid: '0.22s', motionEaseInOut: 'cubic-bezier(.25,1,.5,1)',
      },
      components: {
        Button: { primaryColor: onBrand, dangerColor: mode === 'dark' ? palette.canvas : palette.surface, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', fontWeight: 600 },
        Table: { headerBg: palette.inset, headerColor: palette.muted, cellPaddingBlock: 12, cellPaddingInline: 12 },
        Tabs: { horizontalItemGutter: 20, titleFontSize: 14 },
        Menu: { itemHeight: touch ? 44 : 36 },
        Select: { optionHeight: touch ? 44 : 36, optionPadding: touch ? '12px' : '8px 12px' },
        Segmented: { trackBg: palette.inset, itemSelectedBg: palette.surface },
        Form: { labelColor: palette.ink, labelFontSize: 14, verticalLabelPadding: '0 0 4px', itemMarginBottom: 16 },
        Drawer: { footerPaddingBlock: 12, footerPaddingInline: 20 },
      },
    };
    return { variables, config };
  }, [mode, primaryColor, touch]);
  // Keep the public motion provider mounted: changing Ant's token.motion can
  // insert a provider around the app and discard its unsaved state.
  return (
    <div ref={root} className="wf-root" data-wf-theme={mode} style={design.variables}>
      <SurfaceContext.Provider value={getContainer}>
        <ConfigProvider locale={locale} prefixCls={prefixCls} theme={design.config} getPopupContainer={getContainer}>
          <MotionProvider motion={motion}>
            <App className="wf-app" message={{ getContainer }} notification={{ getContainer }}>{children}</App>
          </MotionProvider>
        </ConfigProvider>
      </SurfaceContext.Provider>
    </div>
  );
}

const glyphs = {
  home: 'M4 10 12 3l8 7v10H4V10Zm5 10v-7h6v7',
  channel: 'M9 3 7 21M17 3l-2 18M3 9h18M2 15h18',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  admin: 'M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3Zm-4 9 3 3 5-6',
  guide: 'M3 4h6c2 0 3 1 3 3v14c0-2-1-3-3-3H3V4Zm9 3c0-2 1-3 3-3h6v14h-6c-2 0-3 1-3 3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M18 6 6 18',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  back: 'M20 12H4m6-6-6 6 6 6',
  plus: 'M12 4v16M4 12h16',
  attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-5 13 8-8',
  send: 'm3 4 18 8-18 8 3-8-3-8Zm3 8h15',
  file: 'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h5',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  browser: 'M3 4h18v16H3V4Zm0 5h18M6 6.5h.1M9 6.5h.1',
  search: 'M16 16 21 21M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  memory: 'M5 4h14v16H5V4Zm3-2v4m8-4v4M8 10h8M8 14h6',
  skill: 'm12 3 2 6 7 3-7 3-2 6-2-6-7-3 7-3 2-6Z',
  schedule: 'M4 5h16v16H4V5Zm3-3v6m10-6v6M4 10h16M8 14h3m3 0h2M8 17h3',
  expand: 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6',
  check: 'm4 12 5 5L20 6',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1',
  retry: 'M20 8a9 9 0 1 0 0 8M20 3v5h-5',
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  chevron: 'm8 4 8 8-8 8',
  lock: 'M5 10h14v11H5V10Zm3 0V6a4 4 0 0 1 8 0v4m-4 5v2',
  logout: 'M10 3H4v18h6m4-14 5 5-5 5M8 12h11',
  copy: 'M8 8h12v13H8V8ZM4 16H2V2h12v2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
} as const;
export type GlyphName = keyof typeof glyphs;
export function Glyph({ name, size = 20, className }: { name: GlyphName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={glyphs[name]} /></svg>;
}

export function BrandMark({ productName, logoUrl, compact = false }: BrandIdentity & { compact?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = Boolean(logoUrl && logoUrl !== failedUrl);
  return (
    <div className={`wf-brand${compact ? ' wf-brand--compact' : ''}`}>
      {showLogo && <img src={logoUrl!} alt="" className="wf-brand-logo" onError={() => setFailedUrl(logoUrl!)} />}
      <span className="wf-brand-name">{productName}</span>
    </div>
  );
}

export interface AppFrameProps {
  brand: BrandIdentity;
  navigation: ReactNode;
  account: ReactNode;
  utilities?: ReactNode;
  children: ReactNode;
  navigationLabel: string;
  openNavigationLabel: string;
  closeNavigationLabel: string;
  skipLabel: string;
  mobileTitle?: ReactNode;
  navigationOpen: boolean;
  onNavigationOpenChange: (open: boolean) => void;
}
export function AppFrame({ brand, navigation, account, utilities, children, navigationLabel, openNavigationLabel, closeNavigationLabel, skipLabel, mobileTitle, navigationOpen: open, onNavigationOpenChange: setOpen }: AppFrameProps) {
  const getContainer = useFieldworkContainer();
  const navigationOpener = useRef<HTMLElement | null>(null);
  const closeIcon = useRef<HTMLSpanElement | null>(null);
  const indexBody = <><div className="wf-index-scroll">{navigation}</div><div className="wf-index-footer"><div className="wf-account">{account}</div>{utilities && <div className="wf-utilities">{utilities}</div>}</div></>;
  return (
    <NavigationCloseContext.Provider value={() => setOpen(false)}>
      <div className="wf-frame">
        <a className="wf-skip" href="#wf-main">{skipLabel}</a>
        <aside className="wf-index" aria-label={navigationLabel}><div className="wf-index-brand"><BrandMark {...brand} /></div>{indexBody}</aside>
        <header className="wf-mobile-bar"><Button type="text" aria-label={openNavigationLabel} aria-expanded={open} icon={<Glyph name="menu" />} onClick={(event) => { navigationOpener.current = event.currentTarget; setOpen(true); }} /><BrandMark {...brand} compact /><span className="wf-mobile-title">{mobileTitle}</span></header>
        <main id="wf-main" tabIndex={-1} className="wf-main">{children}</main>
        <Drawer title={<BrandMark {...brand} />} open={open} onClose={() => setOpen(false)} placement="left" size="min(88vw, 320px)" destroyOnHidden getContainer={getContainer}
          focusable={{ focusTriggerAfterClose: false }}
          afterOpenChange={(visible) => {
            if (visible) {
              const target = closeIcon.current?.closest<HTMLButtonElement>('button');
              const dialog = target?.closest('[role="dialog"]');
              if (dialog && !dialog.contains(document.activeElement)) target?.focus({ preventScroll: true });
            } else {
              navigationOpener.current?.focus({ preventScroll: true });
              navigationOpener.current = null;
            }
          }}
          closeIcon={<span ref={closeIcon}><Glyph name="close" /></span>} closable={{ 'aria-label': closeNavigationLabel }} classNames={{ root: 'wf-drawer', body: 'wf-drawer-nav-body', header: 'wf-drawer-header' }}>{indexBody}</Drawer>
      </div>
    </NavigationCloseContext.Provider>
  );
}

export interface NavigationItem { key: string; label: ReactNode; description?: ReactNode; icon?: ReactNode; trailing?: ReactNode; disabled?: boolean }
export interface NavigationGroup { key: string; label: ReactNode; action?: ReactNode; items: NavigationItem[] }
export interface NavigationProps { label: string; groups: NavigationGroup[]; activeKey?: string; onSelect: (key: string) => void }
export function WorkspaceNav({ label, groups, activeKey, onSelect }: NavigationProps) {
  const closeNavigation = useContext(NavigationCloseContext);
  return <nav aria-label={label} className="wf-navigation">{groups.map((group) => <div className="wf-nav-group" key={group.key}>{(group.label || group.action) && <div className="wf-nav-group-head">{group.label && <span className="wf-eyebrow">{group.label}</span>}{group.action}</div>}<ul className="wf-nav-list">{group.items.map((item) => <li key={item.key}><Button type="text" className={`wf-nav-item${activeKey === item.key ? ' wf-nav-item--active' : ''}`} aria-current={activeKey === item.key ? 'page' : undefined} disabled={item.disabled} onClick={() => { onSelect(item.key); closeNavigation?.(); }}><span className="wf-nav-icon">{item.icon}</span><span className="wf-nav-copy"><span>{item.label}</span>{item.description && <span className="wf-nav-description">{item.description}</span>}</span>{item.trailing && <span className="wf-nav-trailing">{item.trailing}</span>}</Button></li>)}</ul></div>)}</nav>;
}
export function SectionIndex({ label, groups, activeKey, onSelect }: NavigationProps) {
  return <nav className="wf-section-index" aria-label={label}>{groups.map((group) => <div className="wf-section-index-group" key={group.key}>{group.label && <span className="wf-eyebrow">{group.label}</span>}<div className="wf-section-index-items">{group.items.map((item) => <Button key={item.key} type="text" className={`wf-section-index-item${activeKey === item.key ? ' wf-section-index-item--active' : ''}`} aria-current={activeKey === item.key ? 'page' : undefined} disabled={item.disabled} onClick={() => onSelect(item.key)}>{item.icon}{item.label}{item.trailing}</Button>)}</div></div>)}</nav>;
}

export interface PageHeaderProps { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; meta?: ReactNode; actions?: ReactNode }
export function PageHeader({ eyebrow, title, description, meta, actions }: PageHeaderProps) {
  return <header className="wf-page-header"><div className="wf-page-heading">{eyebrow && <div className="wf-eyebrow">{eyebrow}</div>}<h1 className="wf-page-title">{title}</h1>{description && <div className="wf-page-description">{description}</div>}{meta && <div className="wf-page-meta">{meta}</div>}</div>{actions && <div className="wf-page-actions">{actions}</div>}</header>;
}
export function PageLayout({ header, navigation, children }: { header: ReactNode; navigation?: ReactNode; children: ReactNode }) {
  return (
    <div className="wf-page">
      <div className="wf-page-top">
        {header}
        {navigation}
      </div>
      <div className="wf-page-body">
        <div className="wf-page-content">{children}</div>
      </div>
    </div>
  );
}
export function Section({ id, title, description, actions, children, tone = 'plain' }: { id?: string; title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; tone?: 'plain' | 'inset' | 'danger' }) {
  const heading = useId();
  return <section id={id} className={`wf-section wf-section--${tone}`} aria-labelledby={title ? heading : undefined}>{(title || description || actions) && <header className="wf-section-head"><div>{title && <h2 id={heading} className="wf-section-title">{title}</h2>}{description && <div className="wf-section-description">{description}</div>}</div>{actions && <div className="wf-actions">{actions}</div>}</header>}<div className="wf-section-body">{children}</div></section>;
}
export function FormGrid({ children, columns = 2 }: { children: ReactNode; columns?: 1 | 2 }) {
  return <div className={`wf-form-grid wf-form-grid--${columns}`}>{children}</div>;
}
export function FormFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return <div className="wf-form-footer">{note && <div className="wf-form-note">{note}</div>}<div className="wf-actions">{children}</div></div>;
}
export function StatusMark({ tone = 'neutral', children, subtle = false }: { tone?: Tone; children: ReactNode; subtle?: boolean }) {
  return <span className={`wf-status wf-tone-${tone}${subtle ? ' wf-status--subtle' : ''}`}><span className="wf-status-dot" aria-hidden="true" />{children}</span>;
}
export function Notice({ tone = 'info', title, children, action }: { tone?: Tone; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className={`wf-notice wf-tone-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><span className="wf-notice-sign"><Glyph name={tone === 'danger' || tone === 'warning' ? 'warning' : tone === 'success' ? 'check' : 'file'} /></span><div className="wf-notice-copy"><strong>{title}</strong>{children && <div className="wf-notice-detail">{children}</div>}</div>{action && <div className="wf-notice-action">{action}</div>}</div>;
}
export function EmptyState({ eyebrow, title, description, action, compact = false }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return <div className={`wf-empty${compact ? ' wf-empty--compact' : ''}`}>{eyebrow && <div className="wf-eyebrow">{eyebrow}</div>}<h2>{title}</h2>{description && <div className="wf-empty-description">{description}</div>}{action && <div className="wf-empty-action">{action}</div>}</div>;
}
export function LoadingState({ label, detail }: { label: ReactNode; detail?: ReactNode }) {
  return <div className="wf-loading" role="status" aria-live="polite"><span className="wf-loading-line" aria-hidden="true" /><strong>{label}</strong>{detail && <span className="wf-muted">{detail}</span>}</div>;
}
export interface DataRegionProps { state: 'loading' | 'error' | 'empty' | 'ready'; loadingLabel: ReactNode; error?: ReactNode; empty?: ReactNode; retry?: ReactNode; refreshing?: boolean; refreshingLabel?: ReactNode; children?: ReactNode }
export function DataRegion({ state, loadingLabel, error, empty, retry, refreshing = false, refreshingLabel, children }: DataRegionProps) {
  if (state === 'loading') return <LoadingState label={loadingLabel} />;
  if (state === 'error') return <div className="wf-data-region"><Notice tone="danger" title={error} action={retry} /></div>;
  return <div className="wf-data-region" aria-busy={refreshing}>{error && <Notice tone="danger" title={error} action={retry} />}{refreshing && <div className="wf-refreshing" role="status">{refreshingLabel ?? loadingLabel}</div>}<div className="wf-data-content" inert={refreshing || undefined}>{state === 'empty' ? empty : children}</div></div>;
}
export function ResourceList({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className="wf-resource-list" aria-label={label}>{children}</ul>;
}
export interface ResourceRowProps { leading?: ReactNode; title: ReactNode; description?: ReactNode; meta?: ReactNode; status?: ReactNode; actions?: ReactNode; children?: ReactNode; selected?: boolean; onSelect?: () => void; selectLabel?: string }
export function ResourceRow({ leading, title, description, meta, status, actions, children, selected = false, onSelect, selectLabel }: ResourceRowProps) {
  return <li className={`wf-resource-row${selected ? ' wf-resource-row--selected' : ''}`}><div className="wf-resource-main">{leading && <div className="wf-resource-leading">{leading}</div>}<div className="wf-resource-copy"><div className="wf-resource-title-row">{onSelect ? <Button type="text" className="wf-resource-select" aria-label={selectLabel} aria-pressed={selected} onClick={onSelect}>{title}<Glyph name="chevron" size={16} /></Button> : <div className="wf-resource-title">{title}</div>}{status}</div>{description && <div className="wf-resource-description">{description}</div>}{meta && <div className="wf-resource-meta">{meta}</div>}</div>{actions && <div className="wf-resource-actions">{actions}</div>}</div>{children && <div className="wf-resource-detail">{children}</div>}</li>;
}
export interface FactItem { key: string; label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone }
export function FactGrid({ items, columns = 3 }: { items: FactItem[]; columns?: 2 | 3 | 4 }) {
  return <dl className={`wf-facts wf-facts--${columns}`}>{items.map((item) => <div className={`wf-fact${item.tone ? ` wf-tone-${item.tone}` : ''}`} key={item.key}><dt>{item.label}</dt><dd>{item.value}</dd>{item.hint && <dd className="wf-fact-hint">{item.hint}</dd>}</div>)}</dl>;
}
export function SplitDetail({ list, detail, detailOpen, onBack, backLabel }: { list: ReactNode; detail?: ReactNode; detailOpen: boolean; onBack?: () => void; backLabel: string }) {
  return <div className={`wf-split${detailOpen ? ' wf-split--open' : ''}`}><div className="wf-split-list">{list}</div><div className="wf-split-detail">{detailOpen && onBack && <Button className="wf-split-back" type="text" icon={<Glyph name="back" />} onClick={onBack}>{backLabel}</Button>}{detail}</div></div>;
}

export interface AuthPageProps { brand: BrandIdentity; title: ReactNode; description?: ReactNode; form: ReactNode; utilities?: ReactNode; footnote?: ReactNode }
export function AuthPage({ brand, title, description, form, utilities, footnote }: AuthPageProps) {
  return <main className="wf-auth"><div className="wf-auth-main"><header className="wf-auth-top"><BrandMark {...brand} />{utilities && <div className="wf-utilities">{utilities}</div>}</header><div className="wf-auth-form"><h1>{title}</h1>{description && <div className="wf-auth-description">{description}</div>}{form}{footnote && <div className="wf-auth-footnote">{footnote}</div>}</div></div></main>;
}
export interface RecoveryPageProps { brand: BrandIdentity; title: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode; utilities?: ReactNode; detail?: ReactNode }
export function RecoveryPage({ brand, title, description, status, actions, utilities, detail }: RecoveryPageProps) {
  return <main className="wf-recovery"><header className="wf-recovery-top"><BrandMark {...brand} />{utilities && <div className="wf-utilities">{utilities}</div>}</header><section className="wf-recovery-content"><h1>{title}</h1>{description && <div className="wf-recovery-description">{description}</div>}{status}{detail && <div className="wf-recovery-detail">{detail}</div>}{actions && <div className="wf-actions">{actions}</div>}</section></main>;
}
export interface OverlayPanelProps { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'standard' | 'wide'; closeLabel: string }
export function OverlayPanel({ open, onClose, title, description, children, footer, size = 'standard', closeLabel }: OverlayPanelProps) {
  const getContainer = useFieldworkContainer();
  const closeIcon = useRef<HTMLSpanElement | null>(null);
  return <Drawer open={open} onClose={onClose} title={<div className="wf-overlay-heading"><span>{title}</span>{description && <div className="wf-overlay-description">{description}</div>}</div>} footer={footer} size={size === 'wide' ? 'min(100vw, 960px)' : 'min(100vw, 640px)'} destroyOnHidden getContainer={getContainer}
    afterOpenChange={(visible) => {
      if (visible) {
        const target = closeIcon.current?.closest<HTMLButtonElement>('button');
        const dialog = target?.closest('[role="dialog"]');
        if (dialog && !dialog.contains(document.activeElement)) target?.focus({ preventScroll: true });
      }
    }}
    closeIcon={<span ref={closeIcon}><Glyph name="close" /></span>} closable={{ 'aria-label': closeLabel }} classNames={{ root: 'wf-drawer', header: 'wf-drawer-header', body: 'wf-drawer-body', footer: 'wf-drawer-footer' }}>{children}</Drawer>;
}
