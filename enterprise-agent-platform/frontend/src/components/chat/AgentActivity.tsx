import type { AgentStatus } from "../../types";
import { AgentWorkCard } from "./AgentWorkCard";

export function AgentActivity({ status }: { status: AgentStatus }) {
  return <AgentWorkCard work={status} active />;
}
