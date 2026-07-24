import type { ActiveView } from "../../types";
import { _invokePlatformUpdating } from "../../lib/api";

async function maintenanceIsBlocking(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch("/api/platform/update-status", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json() as { state?: string };
    return ["updating", "failed"].includes(
      String(payload.state || ""),
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadRoute<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    if (await maintenanceIsBlocking()) {
      _invokePlatformUpdating();
      // UpdateGate owns recovery/reload. Keep React.lazy suspended so the
      // maintenance HTML returned for a chunk cannot reach the app error
      // boundary during the brief handoff.
      return await new Promise<T>(() => undefined);
    }
    throw error;
  }
}

export const loadKnowledgeRoute = () =>
  loadRoute(() => import("../knowledge/KnowledgeView"));
export const loadSettingsRoute = () =>
  loadRoute(() => import("../settings/SettingsView"));
export const loadAdminRoute = () =>
  loadRoute(() => import("../admin/AdminPanel"));

export function preloadRoute(view: ActiveView): void {
  const pending = view === "knowledge"
    ? loadKnowledgeRoute()
    : view === "settings"
      ? loadSettingsRoute()
      : view === "admin"
        ? loadAdminRoute()
        : null;
  void pending?.catch(() => undefined);
}
