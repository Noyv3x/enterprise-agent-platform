/* <AccountManagement/> — the account-admin card: create form + account list
   (legacy renderAccountManagement, legacy-app.js:1425-1481). Falls back to
   FALLBACK_PERMISSION_GROUPS when no groups are loaded. */

import { FALLBACK_PERMISSION_GROUPS } from "../../../lib/constants";
import { useStore } from "../../../store/useStore";
import { CardHead } from "../../common/CardHead";
import { AccountRow } from "./AccountRow";
import { CreateAccountForm } from "./CreateAccountForm";

export function AccountManagement() {
  const permissionGroups = useStore((state) => state.permissionGroups);
  const users = useStore((state) => state.users);
  const groups = permissionGroups.length ? permissionGroups : FALLBACK_PERMISSION_GROUPS;

  return (
    <section className="card account-admin">
      <CardHead title="账户" icon="users" />
      <CreateAccountForm groups={groups} />
      <div className="account-list">
        {users.length ? (
          users.map((user) => <AccountRow key={String(user.id)} user={user} groups={groups} />)
        ) : (
          <div className="muted">暂无账户。</div>
        )}
      </div>
    </section>
  );
}
