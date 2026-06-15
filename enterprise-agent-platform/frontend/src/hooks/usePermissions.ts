/* usePermissions — wraps the store permission selectors (isAdmin / hasPermission
   / userPermissions, legacy-app.js:349-357) as a memoized hook. Admins
   implicitly hold every permission. */

import { useMemo } from "react";
import { isAdmin as isAdminSelector } from "../store/selectors";
import { useStore } from "../store/useStore";

export interface Permissions {
  isAdmin: boolean;
  has: (permission: string) => boolean;
}

export function usePermissions(): Permissions {
  const admin = useStore(isAdminSelector);
  const permissions = useStore((state) => state.user?.permissions);

  return useMemo<Permissions>(() => {
    const set = new Set(permissions || []);
    return {
      isAdmin: admin,
      has: (permission: string) => admin || set.has(permission),
    };
  }, [admin, permissions]);
}
