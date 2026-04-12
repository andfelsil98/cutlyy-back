export const ROLE_TYPES = ["BUSINESS", "CROSS_BUSINESS", "GLOBAL"] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

export const ACCESS_ENTITY_TYPES = ["BUSINESS", "GLOBAL", "HYBRID"] as const;
export type AccessEntityType = (typeof ACCESS_ENTITY_TYPES)[number];

export const GLOBAL_MODULE_VALUES = new Set([
  "business",
  "businesses",
  "bussinesses",
  "plan",
  "plans",
]);

export const HYBRID_MODULE_VALUES = new Set([
  "users",
  "roles",
  "permissions",
  "modules",
]);

export const GLOBAL_PERMISSION_VALUES = new Set([
  "core.bussinesses.create",
  "core.bussinesses.edit",
  "core.bussinesses.delete",
  "core.bussinesses.list",
  "core.business.createBusiness",
  "core.plan.create",
  "core.plan.edit",
  "core.plan.delete",
  "core.plan.list",
  "core.plans.create",
  "core.plans.edit",
  "core.plans.delete",
  "core.plans.list",
  "core.memberships.create",
  "core.users.delete",
  "core.permissions.create",
  "core.permissions.edit",
  "core.permissions.delete",
  "core.modules.create",
  "core.modules.edit",
  "core.modules.delete",
]);

export const HYBRID_PERMISSION_VALUES = new Set([
  "core.users.list",
  "core.users.activateOrDeactivate",
  "core.users.changeRole",
  "core.roles.list",
  "core.roles.detail",
  "core.roles.create",
  "core.roles.edit",
  "core.roles.delete",
  "core.permissions.list",
  "core.modules.list",
]);

export const DEFAULT_CROSS_BUSINESS_ADMIN_ROLE_NAME = "Super admin";

export function isRoleType(value: unknown): value is RoleType {
  return typeof value === "string" && ROLE_TYPES.includes(value as RoleType);
}

export function isAccessEntityType(value: unknown): value is AccessEntityType {
  return (
    typeof value === "string" &&
    ACCESS_ENTITY_TYPES.includes(value as AccessEntityType)
  );
}

export function isBusinessRoleType(type: RoleType): boolean {
  return type === "BUSINESS" || type === "CROSS_BUSINESS";
}

export function isGlobalRoleType(type: RoleType): boolean {
  return type === "GLOBAL";
}
