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

/** The rule for members with Discord's Administrator permission, stored like a role. */
export const ADMIN_ROLE = 'administrator';

/** Without a stored Administrator rule, administrators hold everything with no limits. */
export const ADMIN_DEFAULT: RoleRule = { roleId: ADMIN_ROLE, permissions: [...PERMISSIONS], limits: NO_LIMITS };

export function adminRule(rules: RoleRule[]): RoleRule {
  return rules.find((rule) => rule.roleId === ADMIN_ROLE) ?? ADMIN_DEFAULT;
}

export function sameRule(a: RoleRule, b: RoleRule) {
  return (
    a.permissions.join() === b.permissions.join() &&
    a.limits.maxAcu === b.limits.maxAcu &&
    a.limits.tasksPerDay === b.limits.tasksPerDay &&
    a.limits.concurrentTasks === b.limits.concurrentTasks
  );
}

/** Administrator counts as one more role, held only through the Discord permission. */
function grantingRoles(member: MemberSnapshot, rules: RoleRule[], permission: Permission) {
  const held = new Set(member.roleIds);
  const roles = rules.filter((rule) => rule.roleId !== ADMIN_ROLE && held.has(rule.roleId));
  if (member.isAdmin) roles.push(adminRule(rules));
  return roles.filter((rule) => rule.permissions.includes(permission));
}

/** Administrator and Manage Server always grant `settings`, so nobody locks themselves out. */
export function hasPermission(
  member: MemberSnapshot,
  rules: RoleRule[],
  permission: Permission
): boolean {
  if (permission === 'settings' && (member.isAdmin || member.canManageGuild)) return true;
  return grantingRoles(member, rules, permission).length > 0;
}

/** Whether this member may use the setup UI for the server. `null`: not a member. */
export function canConfigure(member: MemberSnapshot | null, rules: RoleRule[]): boolean {
  return member !== null && hasPermission(member, rules, 'settings');
}

/**
 * Task limits for a member: the most generous value across their roles that
 * grant `start_tasks`, Administrator included.
 */
export function startLimits(member: MemberSnapshot, rules: RoleRule[]): Limits {
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
