import type { AccessEntityType, RoleType } from "./access-control.constants";

export type ProtectedRoleKey = "SUPER_ADMIN" | "ADMIN" | "OWNER";

export interface ProtectedRoleDefinition {
  key: ProtectedRoleKey;
  id: string;
  name: string;
  type: RoleType;
  compatiblePermissionTypes: AccessEntityType[];
}

const PROTECTED_ROLE_DEFINITIONS: Record<ProtectedRoleKey, ProtectedRoleDefinition> = {
  SUPER_ADMIN: {
    key: "SUPER_ADMIN",
    id: "xuU5l4dY494HkSFCZZvO",
    name: "Super admin",
    type: "GLOBAL",
    compatiblePermissionTypes: ["GLOBAL", "HYBRID"],
  },
  ADMIN: {
    key: "ADMIN",
    id: "oGBC0OyekiJPnboEdU8W",
    name: "Admin",
    type: "CROSS_BUSINESS",
    compatiblePermissionTypes: ["BUSINESS", "HYBRID"],
  },
  OWNER: {
    key: "OWNER",
    id: "6gujn8AX4boW2C2RGjNA",
    name: "Owner",
    type: "CROSS_BUSINESS",
    compatiblePermissionTypes: ["BUSINESS", "HYBRID"],
  },
};

function normalizeRoleName(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function getProtectedRoleDefinition(
  key: ProtectedRoleKey
): ProtectedRoleDefinition {
  return PROTECTED_ROLE_DEFINITIONS[key];
}

export function getProtectedRoleDefinitions(): ProtectedRoleDefinition[] {
  return Object.values(PROTECTED_ROLE_DEFINITIONS);
}

export function resolveProtectedRoleDefinition(
  input: {
    id?: string | null;
    name?: string | null;
    type?: RoleType | null;
  } | null | undefined
): ProtectedRoleDefinition | null {
  if (!input) return null;

  const normalizedId = typeof input.id === "string" ? input.id.trim() : "";
  if (normalizedId !== "") {
    const matchedById =
      getProtectedRoleDefinitions().find((definition) => definition.id === normalizedId) ??
      null;
    if (matchedById) return matchedById;
  }

  const normalizedName = normalizeRoleName(input.name);
  const normalizedType = input.type ?? null;
  if (normalizedName === "" || normalizedType == null) return null;

  return (
    getProtectedRoleDefinitions().find(
      (definition) =>
        definition.type === normalizedType &&
        normalizeRoleName(definition.name) === normalizedName
    ) ?? null
  );
}

export function isProtectedRole(
  input: {
    id?: string | null;
    name?: string | null;
    type?: RoleType | null;
  } | null | undefined
): boolean {
  return resolveProtectedRoleDefinition(input) != null;
}

export function isAdminProtectedRole(
  input: {
    id?: string | null;
    name?: string | null;
    type?: RoleType | null;
  } | null | undefined
): boolean {
  return resolveProtectedRoleDefinition(input)?.key === "ADMIN";
}

export function isSuperAdminProtectedRole(
  input: {
    id?: string | null;
    name?: string | null;
    type?: RoleType | null;
  } | null | undefined
): boolean {
  return resolveProtectedRoleDefinition(input)?.key === "SUPER_ADMIN";
}

export const PROTECTED_SUPER_ADMIN_USER_ID = "Jgz2gwvgdfJBoa28bzGZ";

export function isProtectedSuperAdminUserId(
  userId: string | null | undefined
): boolean {
  return typeof userId === "string" && userId.trim() === PROTECTED_SUPER_ADMIN_USER_ID;
}
