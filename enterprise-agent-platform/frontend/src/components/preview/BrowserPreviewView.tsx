import { useMemo } from "react";
import { useI18n } from "../../i18n";
import { intlLocale } from "../../i18n";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";
import { PageHeader } from "../common/PageHeader";
import { PreviewScopeSelect } from "./PreviewScopeSelect";
import { PreviewStatus } from "./PreviewStatus";
import { useBrowserPreview } from "./useBrowserPreview";
import { usePreviewScope } from "./usePreviewScope";

function previewTime(value: string | number | null, locale: string): string {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function BrowserPreviewView() {
  const { t, locale } = useI18n();
  const { options, selected, select } = usePreviewScope();
  const scope = useMemo(
    () => selected ? { scope_type: selected.scope_type, scope_id: selected.scope_id } : null,
    [selected],
  );
  const { state, refresh } = useBrowserPreview(scope);
  const lastUpdate = previewTime(state.capturedAt || state.checkedAt, intlLocale(locale));

  return (
    <div className="panel preview-panel">
      <div className="panel__inner preview-panel__inner">
        <PageHeader
          title={t("browserPreview.title")}
          description={t("browserPreview.description")}
          actions={<PreviewScopeSelect options={options} selected={selected} onChange={select} />}
        />
        {!selected ? (
          <div className="preview-empty-card">
            <EmptyState icon="browser" title={t("preview.noScope")} text={t("preview.noScopeDetail")} />
          </div>
        ) : (
          <section className="browser-preview" aria-label={t("browserPreview.title")}>
            <header className="preview-toolbar">
              <div className="preview-toolbar__status">
                <PreviewStatus connection={state.connection} idle={state.activity === "idle"} />
                <span className="status"><Icon name="shield" size={12} />{t("preview.readOnly")}</span>
                {lastUpdate ? <span className="preview-updated">{t("preview.updatedAt", { time: lastUpdate })}</span> : null}
              </div>
              <button className="btn btn--sm" type="button" onClick={refresh}>
                <Icon name="refresh" size={14} />
                <span>{t("preview.refresh")}</span>
              </button>
            </header>
            {state.error ? (
              <InlineAlert variant="warning">{state.error || t("preview.loadFailed")}</InlineAlert>
            ) : null}
            <div className="browser-preview__window">
              <div className="browser-preview__chrome" aria-hidden="true">
                <span className="browser-preview__lights"><i /><i /><i /></span>
                <div className="browser-preview__address">
                  <Icon name="shield" size={12} />
                  <span>{state.url || state.title || t("browserPreview.page")}</span>
                </div>
              </div>
              <div className="browser-preview__screen">
                {state.frameUrl ? (
                  <img
                    src={state.frameUrl}
                    alt={t("browserPreview.frameAlt")}
                    draggable={false}
                  />
                ) : (
                  <EmptyState
                    icon="browser"
                    title={t("browserPreview.noBrowser")}
                    text={t("browserPreview.noBrowserDetail")}
                  />
                )}
                <div className="browser-preview__readonly-shield" aria-hidden="true" />
              </div>
            </div>
            {state.title || state.url ? (
              <footer className="browser-preview__meta">
                <strong>{state.title || t("browserPreview.page")}</strong>
                {state.url ? <span>{state.url}</span> : null}
              </footer>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}
