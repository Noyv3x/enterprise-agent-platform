import { useEffect, useMemo } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { useI18n } from "../../i18n";
import { useDispatch, useStore } from "../../store/useStore";
import type { AgentPreviewScope } from "../../types";

export interface AgentPreviewScopeOption extends AgentPreviewScope {
  key: string;
  label: string;
}

function scopeKey(scope: AgentPreviewScope): string {
  return `${scope.scope_type}:${scope.scope_id}`;
}

export function usePreviewScope() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const dispatch = useDispatch();
  const user = useStore((state) => state.user);
  const channels = useStore((state) => state.channels);
  const storedScope = useStore((state) => state.previewScope);

  const options = useMemo<AgentPreviewScopeOption[]>(() => {
    const next: AgentPreviewScopeOption[] = [];
    if (permissions.has("private_agent") && user) {
      next.push({
        scope_type: "private",
        scope_id: String(user.id),
        key: `private:${String(user.id)}`,
        label: t("nav.privateAgent"),
      });
    }
    for (const channel of channels) {
      next.push({
        scope_type: "channel",
        scope_id: String(channel.id),
        key: `channel:${String(channel.id)}`,
        label: t("preview.channelScope", { name: channel.name }),
      });
    }
    return next;
  }, [channels, permissions, t, user]);

  const storedKey = storedScope ? scopeKey(storedScope) : "";
  const selected = options.find((option) => option.key === storedKey) || options[0] || null;

  useEffect(() => {
    if (!selected || selected.key === storedKey) return;
    dispatch({
      type: "SET_PREVIEW_SCOPE",
      payload: { scope_type: selected.scope_type, scope_id: selected.scope_id },
    });
  }, [dispatch, selected, storedKey]);

  const select = (key: string) => {
    const next = options.find((option) => option.key === key);
    if (!next) return;
    dispatch({
      type: "SET_PREVIEW_SCOPE",
      payload: { scope_type: next.scope_type, scope_id: next.scope_id },
    });
  };

  return { options, selected, select };
}
