import { useI18n } from "../../i18n";
import type { ComputerSearchHit } from "../../types";
import { EmptyState } from "../common/EmptyState";

interface SearchComputerViewProps {
  hits: ComputerSearchHit[];
}

export function SearchComputerView({ hits }: SearchComputerViewProps) {
  const { t } = useI18n();
  if (!hits.length) {
    return (
      <EmptyState
        icon="search"
        title={t("computer.mode.search")}
        text={t("computer.search.empty")}
      />
    );
  }
  return (
    <ul className="computer-search">
      {hits.map((hit, index) => {
        const location = hit.url || hit.workspace_path || "";
        return (
          <li className="computer-search__item" key={`${hit.title}:${location}:${index}`}>
            <strong>{hit.title || t("computer.search.untitled")}</strong>
            {location ? <span>{location}</span> : null}
            {hit.snippet ? <p>{hit.snippet}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
