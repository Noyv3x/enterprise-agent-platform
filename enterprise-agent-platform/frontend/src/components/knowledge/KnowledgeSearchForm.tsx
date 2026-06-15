/* <KnowledgeSearchForm/> — the .search-field form (legacy-app.js:1293-1313).
   The input is controlled by local state kept SEPARATE from the committed
   knowledgeSearch.query. The committed query only changes when a request
   resolves (or on clear/reset), never during the in-flight render, which
   eliminates the legacy value-flash quirk (spec §7) while a clear/post-create
   reset still empties the input via the sync effect below. */

import { useEffect, useState } from "react";
import { clearSearch, searchKnowledge } from "../../data/knowledgeActions";
import { runBusy } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function KnowledgeSearchForm() {
  const store = useStoreHandle();
  const search = useStore((state) => state.knowledgeSearch);
  const isSearching = !!search.query && Array.isArray(search.results);
  const [value, setValue] = useState(search.query);

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
        void runBusy(store, () => searchKnowledge(store, query));
      }}
    >
      <div className="search-field">
        <Icon name="search" />
        <input
          placeholder="搜索标题或正文…"
          aria-label="搜索知识库"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {isSearching ? (
          <button
            className="icon-btn search-field__clear"
            type="button"
            title="清除搜索"
            aria-label="清除搜索，显示全部条目"
            onClick={() => clearSearch(store)}
          >
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>
    </form>
  );
}
