import type { Translator } from ".";

/** Localize the fixed permission groups returned by the platform API. */
export function permissionGroupLabel(t: Translator, id: string, fallback?: string): string {
  switch (id) {
    case "admin": return t("admin.permissionGroup.admin");
    case "manager": return t("admin.permissionGroup.manager");
    case "member": return t("admin.permissionGroup.member");
    case "viewer": return t("admin.permissionGroup.viewer");
    default: return fallback || id;
  }
}
