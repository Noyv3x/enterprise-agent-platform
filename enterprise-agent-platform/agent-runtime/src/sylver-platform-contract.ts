export const SYLVER_PLATFORM_READ_ACTIONS = [
  "whoami",
  "projects",
  "project",
  "project_context",
  "tasks",
  "task",
  "task_activity",
  "wiki_list",
  "wiki_read",
  "approvals",
  "approval",
  "approval_comments",
  "notifications",
] as const;

export const SYLVER_PLATFORM_MUTATION_ACTIONS = [
  "create_task",
  "start_task",
  "add_task_activity",
  "propose_wiki",
  "comment_approval",
] as const;

export const SYLVER_PLATFORM_ACTIONS = [
  ...SYLVER_PLATFORM_READ_ACTIONS,
  ...SYLVER_PLATFORM_MUTATION_ACTIONS,
] as const;

const SYLVER_PLATFORM_ACTION_SET = new Set<string>(SYLVER_PLATFORM_ACTIONS);
const SYLVER_PLATFORM_MUTATION_ACTION_SET = new Set<string>(SYLVER_PLATFORM_MUTATION_ACTIONS);

export function isSylverPlatformAction(action: unknown): action is typeof SYLVER_PLATFORM_ACTIONS[number] {
  return typeof action === "string" && SYLVER_PLATFORM_ACTION_SET.has(action);
}

export function isSylverPlatformMutation(
  action: unknown,
): action is typeof SYLVER_PLATFORM_MUTATION_ACTIONS[number] {
  return typeof action === "string" && SYLVER_PLATFORM_MUTATION_ACTION_SET.has(action);
}
