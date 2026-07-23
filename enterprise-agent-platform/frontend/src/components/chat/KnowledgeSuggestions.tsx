/* <KnowledgeSuggestions/> — the inline knowledge-suggestion chips under an agent
   message (legacy renderMessage suggest block, :892-895). */

import type { KnowledgeSuggestion } from "../../types";
import { Tag } from "antd";

export function KnowledgeSuggestions({ suggestions }: { suggestions: KnowledgeSuggestion[] }) {
  return (
    <div className="msg__suggest">
      {suggestions.map((suggestion) => (
        <Tag className="chip" key={String(suggestion.id)}>
          <span className="chip__id">{`kb:${suggestion.id}`}</span>
          <span>{suggestion.title}</span>
        </Tag>
      ))}
    </div>
  );
}
