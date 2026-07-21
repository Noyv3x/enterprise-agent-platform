/* <KnowledgeSearchForm/> — the .search-field form (legacy-app.js:1293-1313).
   The input is controlled by local state kept SEPARATE from the committed
   knowledgeSearch.query. The committed query only changes when a request
   resolves (or on clear/reset), never during the in-flight render, which
   eliminates the legacy value-flash quirk (spec §7) while a clear/post-create
   reset still empties the input via the sync effect below. */

import { useEffect, useState } from "react";
import { clearSearch, searchKnowledge } from "../../data/knowledgeActions";
import { resourceKeys, runResourceLoad } from "../../data/resourceState";
import { useResourceState } from "../../hooks/useResourceState";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";

export function KnowledgeSearchForm() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const search = useStore((state) => state.knowledgeSearch);
  const isSearching = !!search.query && Array.isArray(search.results);
  const [value, setValue] = useState(search.query);
  const resource = useResourceState(resourceKeys.knowledgeSearch);

  // Pull the input down to the committed query whenever the committed query
  // changes (search success, X clear, "显示全部", or the post-create reset).
  // It does NOT fire mid-request — the committed query is unchanged until the
  // request resolves — so typing/in-flight state is never clobbered.
  useEffect(() => {
    setValue(search.query);
  }, [search.query]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (!query) {
          clearSearch(store);
          return;
        }
        void runResourceLoad(store, resourceKeys.knowledgeSearch, () => searchKnowledge(store, query));
      }}
    >
      <div className="search-field search-field--action">
        <div className="search-field__control">
          <Icon name="search" />
          <input
            placeholder={t("knowledge.searchPlaceholder")}
            aria-label={t("knowledge.searchLabel")}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {isSearching ? (
            <button
              className="icon-btn search-field__clear"
              type="button"
              disabled={resource.status === "loading"}
              title={t("knowledge.clearSearch")}
              aria-label={t("knowledge.clearSearchDetail")}
              onClick={() => clearSearch(store)}
            >
              <Icon name="close" size={15} />
            </button>
          ) : null}
        </div>
        <button className="btn btn--primary btn--sm search-field__submit" type="submit" disabled={!value.trim() || resource.status === "loading"}>
          <span>{resource.status === "loading" ? t("knowledge.searching") : t("knowledge.search")}</span>
        </button>
      </div>
      {resource.status === "error" ? (
        <InlineAlert variant="error" title={t("resource.loadFailed")}>
          {resource.error}
        </InlineAlert>
      ) : null}
    </form>
  );
}
