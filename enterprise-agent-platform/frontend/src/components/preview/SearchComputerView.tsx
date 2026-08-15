import { useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type { ComputerSearchHit } from "../../types";
import { EmptyState } from "../common/EmptyState";

interface SearchComputerViewProps {
  hits: ComputerSearchHit[];
  compact?: boolean;
}

export function SearchComputerView({ hits, compact = false }: SearchComputerViewProps) {
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
    <ul className={cx("computer-search", compact && "computer-search--compact")}>
      {hits.map((hit, index) => {
        const location = hit.url || hit.workspace_path || "";
        return (
          <li className="computer-search__item" key={`${hit.title}:${location}:${index}`}>
            <strong>{hit.title || t("computer.search.untitled")}</strong>
            {location ? <span>{location}</span> : null}
            {hit.snippet && (!compact || index === 0) ? <p>{hit.snippet}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
