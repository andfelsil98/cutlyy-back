import { CustomError } from "../../domain/errors/custom-error";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Role } from "../../domain/interfaces/role.interface";
import type { User } from "../../domain/interfaces/user.interface";
import FirestoreService from "./firestore.service";
import { UserService } from "./user.service";

const MEMBERSHIPS_COLLECTION = "BusinessMemberships";
const ROLES_COLLECTION = "Roles";

export interface GlobalAccessContext {
  user: User;
  membership: BusinessMembership;
  role: Role;
  permissionValues: Set<string>;
}

export interface BusinessAccessContext {
  user: User;
  membership: BusinessMembership;
  role: Role;
  businessId: string;
  permissionValues: Set<string>;
}

function normalizeBusinessId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export class AccessControlService {
  constructor(private readonly userService: UserService = new UserService()) {}

  async getGlobalAccessContextByDocument(
    document: string
  ): Promise<GlobalAccessContext | null> {
    const normalizedDocument = document.trim();
    if (normalizedDocument === "") return null;

    const user = await this.userService.getByDocument(normalizedDocument);
    if (!user) return null;

    const memberships = await this.getMembershipsByUser(user);
    const membership =
      memberships.find(
        (item) =>
          item.status === "ACTIVE" && normalizeBusinessId(item.businessId) === ""
      ) ?? null;
    if (!membership?.roleId?.trim()) return null;

    const role = await this.getRoleById(membership.roleId.trim());
    if (!role || role.type !== "GLOBAL") return null;

    const permissionValues = await this.getRolePermissionValues(role.id);
    return {
      user,
      membership,
      role,
      permissionValues,
    };
  }

  async requireGlobalPermission(
    document: string,
    permissionValue: string
  ): Promise<GlobalAccessContext> {
    const context = await this.getGlobalAccessContextByDocument(document);
    if (!context) {
      throw CustomError.forbidden(
        "No tienes una membresía global activa para ejecutar esta acción."
      );
    }

    const normalizedPermission = permissionValue.trim();
    if (!context.permissionValues.has(normalizedPermission)) {
      throw CustomError.forbidden(
        "No tienes el permiso global requerido para ejecutar esta acción."
      );
    }

    return context;
  }

  async getBusinessAccessContextByDocument(
    document: string,
    businessId: string
  ): Promise<BusinessAccessContext | null> {
    const normalizedDocument = document.trim();
    const normalizedBusinessId = businessId.trim();
    if (normalizedDocument === "" || normalizedBusinessId === "") return null;

    const user = await this.userService.getByDocument(normalizedDocument);
    if (!user) return null;

    const memberships = await this.getMembershipsByUser(user);
    const membership =
      memberships.find(
        (item) =>
          item.status === "ACTIVE" &&
          normalizeBusinessId(item.businessId) === normalizedBusinessId
      ) ?? null;
    if (!membership?.roleId?.trim()) return null;

    const role = await this.getRoleById(membership.roleId.trim());
    if (!role) return null;

    const permissionValues = await this.getRolePermissionValues(role.id);
    return {
      user,
      membership,
      role,
      businessId: normalizedBusinessId,
      permissionValues,
    };
  }

  async requireBusinessPermission(
    document: string,
    businessId: string,
    permissionValue: string
  ): Promise<BusinessAccessContext> {
    const context = await this.getBusinessAccessContextByDocument(
      document,
      businessId
    );
    if (!context) {
      throw CustomError.forbidden(
        "No tienes una membresía activa en el negocio indicado para ejecutar esta acción."
      );
    }

    const normalizedPermission = permissionValue.trim();
    if (!context.permissionValues.has(normalizedPermission)) {
      throw CustomError.forbidden(
        "No tienes el permiso del negocio requerido para ejecutar esta acción."
      );
    }

    return context;
  }

  async requireAnyBusinessPermission(
    document: string,
    businessId: string,
    permissionValues: string[]
  ): Promise<BusinessAccessContext> {
    const context = await this.getBusinessAccessContextByDocument(
      document,
      businessId
    );
    if (!context) {
      throw CustomError.forbidden(
        "No tienes una membresía activa en el negocio indicado para ejecutar esta acción."
      );
    }

    const normalizedPermissions = permissionValues
      .map((permissionValue) => permissionValue.trim())
      .filter((permissionValue) => permissionValue !== "");
    if (normalizedPermissions.length === 0) {
      throw CustomError.internalServerError(
        "Configuración inválida de permisos de negocio."
      );
    }

    const hasAnyPermission = normalizedPermissions.some((permissionValue) =>
      context.permissionValues.has(permissionValue)
    );
    if (!hasAnyPermission) {
      throw CustomError.forbidden(
        "No tienes ninguno de los permisos del negocio requeridos para ejecutar esta acción."
      );
    }

    return context;
  }

  async hasActiveBusinessMembership(
    document: string,
    businessId: string
  ): Promise<boolean> {
    const normalizedDocument = document.trim();
    const normalizedBusinessId = businessId.trim();
    if (normalizedDocument === "" || normalizedBusinessId === "") return false;

    const user = await this.userService.getByDocument(normalizedDocument);
    if (!user) return false;

    const memberships = await this.getMembershipsByUser(user);
    return memberships.some(
      (membership) =>
        membership.status !== "DELETED" &&
        normalizeBusinessId(membership.businessId) === normalizedBusinessId
    );
  }

  private async getMembershipsByUser(user: User): Promise<BusinessMembership[]> {
    const [membershipsByDocument, membershipsById] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(MEMBERSHIPS_COLLECTION, [
        { field: "userId", operator: "==", value: user.document },
      ]),
      FirestoreService.getAll<BusinessMembership>(MEMBERSHIPS_COLLECTION, [
        { field: "userId", operator: "==", value: user.id },
      ]),
    ]);

    const membershipsMap = new Map<string, BusinessMembership>();
    membershipsByDocument.forEach((membership) =>
      membershipsMap.set(membership.id, membership)
    );
    membershipsById.forEach((membership) =>
      membershipsMap.set(membership.id, membership)
    );

    return Array.from(membershipsMap.values());
  }

  private async getRoleById(roleId: string): Promise<Role | null> {
    const roles = await FirestoreService.getAll<Role>(ROLES_COLLECTION, [
      { field: "id", operator: "==", value: roleId },
    ]);
    return roles[0] ?? null;
  }

  private async getRolePermissionValues(roleId: string): Promise<Set<string>> {
    const permissions = await FirestoreService.getAllFromSubcollection<{
      value?: string;
    }>(ROLES_COLLECTION, roleId, "Permissions");

    return new Set(
      permissions
        .map((permission) => permission.value?.trim() ?? "")
        .filter((value) => value !== "")
    );
  }
}
