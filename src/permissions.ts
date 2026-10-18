export const PERMISSIONS = ['start_tasks', 'reply', 'manage_tasks', 'settings'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  start_tasks: 'Start tasks',
  reply: 'Reply in task threads',
  manage_tasks: 'Manage tasks',
  settings: 'Change settings'
};

/** `null` means no limit. */
export type Limits = {
  maxAcu: number | null;
  tasksPerDay: number | null;
  concurrentTasks: number | null;
};

export const NO_LIMITS: Limits = { maxAcu: null, tasksPerDay: null, concurrentTasks: null };

export type RoleRule = {
  roleId: string;
  permissions: Permission[];
  limits: Limits;
};

/** A guild member as the bot sees them. `roleIds` includes @everyone (the guild ID). */
export type MemberSnapshot = {
  id: string;
  name: string;
  roleIds: string[];
  isAdmin: boolean;
  canManageGuild: boolean;
};

function grantingRoles(member: MemberSnapshot, rules: RoleRule[], permission: Permission) {
  const held = new Set(member.roleIds);
  return rules.filter((rule) => held.has(rule.roleId) && rule.permissions.includes(permission));
}

/** Administrators hold every permission; Manage Server also grants `settings`. */
export function hasPermission(
  member: MemberSnapshot,
  rules: RoleRule[],
  permission: Permission
): boolean {
  if (member.isAdmin) return true;
  if (permission === 'settings' && member.canManageGuild) return true;
  return grantingRoles(member, rules, permission).length > 0;
}

/** Whether this member may use the setup UI for the server. `null`: not a member. */
export function canConfigure(member: MemberSnapshot | null, rules: RoleRule[]): boolean {
  return member !== null && hasPermission(member, rules, 'settings');
}

/**
 * Task limits for a member: the most generous value across their roles that
 * grant `start_tasks`. Administrators have none.
 */
export function startLimits(member: MemberSnapshot, rules: RoleRule[]): Limits {
  if (member.isAdmin) return NO_LIMITS;
  const roles = grantingRoles(member, rules, 'start_tasks');
  const most = (key: keyof Limits) => {
    let best: number | null = 0;
    for (const role of roles) {
      const value = role.limits[key];
      if (value === null) return null;
      best = Math.max(best, value);
    }
    return roles.length ? best : 0;
  };
  return {
    maxAcu: most('maxAcu'),
    tasksPerDay: most('tasksPerDay'),
    concurrentTasks: most('concurrentTasks')
  };
}
