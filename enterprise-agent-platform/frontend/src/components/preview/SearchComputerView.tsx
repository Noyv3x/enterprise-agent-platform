import { useI18n } from "../../i18n";
import type { ComputerSearchHit } from "../../types";
import { ComputerOutput, EmptyState, ResourceList, ResourceRow } from "../ui/beautiful"

export function SearchComputerView({hits, compact=false}: {hits:ComputerSearchHit[];compact?:boolean}) {
  const {t}=useI18n();
  return <div className="bui-search-view" data-compact={compact || undefined}>
    <ComputerOutput kind="search">
      {hits.length ? <ResourceList label={t("computer.mode.search")}>{hits.map((hit,index) => <ResourceRow key={`${index}:${hit.url || hit.workspace_path || hit.title}`} title={hit.title || t("computer.search.untitled")} meta={hit.url || hit.workspace_path} description={hit.snippet} />)}</ResourceList>
        : <EmptyState compact title={t("computer.mode.search")} description={t("computer.search.empty")} />}
    </ComputerOutput>
  </div>;
}
