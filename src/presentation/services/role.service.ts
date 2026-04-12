import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import {
  isBusinessRoleType,
  isGlobalRoleType,
  type RoleType,
} from "../../domain/constants/access-control.constants";
import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Permission } from "../../domain/interfaces/permission.interface";
import type { Role } from "../../domain/interfaces/role.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import {
  buildPagination,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import { BusinessUsageLimitService } from "./business-usage-limit.service";
import FirestoreService from "./firestore.service";
import type { CreateRoleDto } from "../role/dtos/create-role.dto";
import type {
  PermissionUpdateOperationDto,
  UpdateRoleDto,
} from "../role/dtos/update-role.dto";

const COLLECTION_NAME = "Roles";
const BUSINESS_COLLECTION = "Businesses";
const PERMISSIONS_COLLECTION = "Permissions";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

export class RoleService {
  constructor(
    private readonly businessUsageLimitService: BusinessUsageLimitService =
      new BusinessUsageLimitService()
  ) {}

  async getAllRoles(
    params: PaginationParams & { businessId?: string }
  ): Promise<PaginatedResult<Role>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, params.pageSize)
      );
      const businessId =
        params.businessId != null && params.businessId.trim() !== ""
          ? params.businessId.trim()
          : undefined;

      if (!businessId) {
        const roles = await FirestoreService.getAll<Role>(COLLECTION_NAME, [
          { field: "type", operator: "in", value: ["GLOBAL", "CROSS_BUSINESS"] },
        ]);
        roles.sort((left, right) =>
          (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
        );
        const total = roles.length;
        const offset = (page - 1) * pageSize;
        return {
          data: roles.slice(offset, offset + pageSize),
          total,
          pagination: buildPagination(page, pageSize, total),
        };
      }

      const [
        crossBusinessRoles,
        businessRolesPage,
        businessRolesTotal,
      ] = await Promise.all([
        FirestoreService.getAll<Role>(COLLECTION_NAME, [
          { field: "type", operator: "==", value: "CROSS_BUSINESS" },
        ]),
        FirestoreService.getAllPaginated<Role>(
          COLLECTION_NAME,
          { page, pageSize },
          [
            { field: "type", operator: "==", value: "BUSINESS" },
            { field: "businessId", operator: "==", value: businessId },
          ]
        ),
        (async () => {
          const allBusiness = await FirestoreService.getAll<Role>(COLLECTION_NAME, [
            { field: "type", operator: "==", value: "BUSINESS" },
            { field: "businessId", operator: "==", value: businessId },
          ]);
          return allBusiness.length;
        })(),
      ]);

      const combinedData = [...crossBusinessRoles, ...businessRolesPage.data];
      const total = crossBusinessRoles.length + businessRolesTotal;

      return {
        data: combinedData,
        total,
        pagination: buildPagination(page, pageSize, total),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async getRoleWithPermissionsById(
    id: string
  ): Promise<{
    role: Role;
    permissions: Array<{ id: string; name: string; value: string; moduleId: string }>;
  }> {
    try {
      const roles = await FirestoreService.getAll<Role>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (roles.length === 0) {
        throw CustomError.notFound("No existe un rol con este id");
      }
      const role = roles[0]!;

      const permissionsSnapshot = await FirestoreService.getAllFromSubcollection<{
        name?: string;
        value?: string;
        moduleId?: string;
      }>(COLLECTION_NAME, id, "Permissions");

      const permissions = permissionsSnapshot.map((permissionDoc) => {
        return {
          id: permissionDoc.id,
          name: permissionDoc.name ?? "",
          value: permissionDoc.value ?? "",
          moduleId: permissionDoc.moduleId ?? "",
        };
      });

      return { role, permissions };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createRole(dto: CreateRoleDto): Promise<Role> {
    let consumedBusinessId: string | null = null;
    let createdRoleId: string | null = null;

    try {
      const existingRoles = await FirestoreService.getAll<Role>(COLLECTION_NAME);
      const nameKey = toNameKey(dto.name);
      const duplicated = existingRoles.some((role) => toNameKey(role.name) === nameKey);
      if (duplicated) {
        throw CustomError.conflict("Ya existe un rol con este nombre");
      }

      if (dto.type === "BUSINESS") {
        const businesses = await FirestoreService.getAll<Business>(
          BUSINESS_COLLECTION,
          [{ field: "id", operator: "==", value: dto.businessId }]
        );
        if (businesses.length === 0) {
          throw CustomError.notFound("No existe un negocio con este id");
        }
      }

      // Validar que todos los permisos existan
      const resolvedPermissions: Permission[] = [];
      for (const [index, permissionId] of dto.permissions.entries()) {
        const permissions = await FirestoreService.getAll<Permission>(
          PERMISSIONS_COLLECTION,
          [{ field: "id", operator: "==", value: permissionId }]
        );
        if (permissions.length === 0) {
          throw CustomError.notFound(
            `No existe un permiso con el id indicado en la posición ${index}`
          );
        }
        resolvedPermissions.push(permissions[0]!);
      }
      this.ensurePermissionsCompatibleWithRoleType(dto.type, resolvedPermissions);

      if (dto.type === "BUSINESS") {
        await this.businessUsageLimitService.consume(dto.businessId!, "roles", 1);
        consumedBusinessId = dto.businessId!;
      }

      const data = {
        name: dto.name,
        type: dto.type,
        permissionsCount: resolvedPermissions.length,
        ...(dto.businessId !== undefined && { businessId: dto.businessId }),
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };

      const role = (await FirestoreService.create(
        COLLECTION_NAME,
        data
      )) as Role;
      createdRoleId = role.id;

      // Crear subcolección permissions bajo el rol
      for (const permission of resolvedPermissions) {
        await FirestoreService.createInSubcollection(
          COLLECTION_NAME,
          role.id,
          "Permissions",
          {
            id: permission.id,
            name: permission.name,
            value: permission.value,
            moduleId: permission.moduleId,
            type: permission.type,
          }
        );
      }

      return role;
    } catch (error) {
      if (createdRoleId != null) {
        await FirestoreService.deleteSubcollectionDocuments(
          COLLECTION_NAME,
          createdRoleId,
          "Permissions"
        ).catch(() => undefined);
        await FirestoreService.delete(COLLECTION_NAME, createdRoleId).catch(() => undefined);
      }
      if (consumedBusinessId != null) {
        await this.businessUsageLimitService.release(consumedBusinessId, "roles", 1).catch(() => undefined);
      }
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updateRole(id: string, dto: UpdateRoleDto): Promise<Role> {
    try {
      const roles = await FirestoreService.getAll<Role>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (roles.length === 0) {
        throw CustomError.notFound("No existe un rol con este id");
      }

      const role = roles[0]!;
      const currentPermissionsSnapshot = await FirestoreService.getAllFromSubcollection<{
        id: string;
      }>(COLLECTION_NAME, id, "Permissions");
      const currentPermissionIds = new Set(
        currentPermissionsSnapshot.map((permissionDoc) => permissionDoc.id)
      );

      const payload: Record<string, unknown> = {
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };
      if (dto.name !== undefined) {
        const nameKey = toNameKey(dto.name);
        const existingRoles = await FirestoreService.getAll<Role>(COLLECTION_NAME);
        const duplicated = existingRoles.some(
          (existingRole) => existingRole.id !== id && toNameKey(existingRole.name) === nameKey
        );
        if (duplicated) {
          throw CustomError.conflict("Ya existe un rol con este nombre");
        }
        payload.name = dto.name;
      }

      if (dto.permissions !== undefined) {
        const resolvedOperations = await this.resolvePermissionOperations(
          dto.permissions
        );

        for (const operation of resolvedOperations) {
          if (operation.op === "add") {
            if (currentPermissionIds.has(operation.permission.id)) {
              throw CustomError.conflict(
                `El rol ya tiene asociado el permiso ${operation.permission.id}`
              );
            }
            this.ensurePermissionsCompatibleWithRoleType(role.type, [
              operation.permission,
            ]);
            await FirestoreService.createInSubcollection(
              COLLECTION_NAME,
              role.id,
              "Permissions",
              {
                id: operation.permission.id,
                name: operation.permission.name,
                value: operation.permission.value,
                moduleId: operation.permission.moduleId,
                type: operation.permission.type,
              }
            );
            currentPermissionIds.add(operation.permission.id);
            continue;
          }

          if (!currentPermissionIds.has(operation.permission.id)) {
            throw CustomError.badRequest(
              `No se puede remover el permiso ${operation.permission.id} porque no está asociado al rol`
            );
          }
          await FirestoreService.deleteSubcollectionDocument(
            COLLECTION_NAME,
            id,
            "Permissions",
            operation.permission.id
          );
          currentPermissionIds.delete(operation.permission.id);
        }

        payload.permissionsCount = currentPermissionIds.size;
      }

      await FirestoreService.update(COLLECTION_NAME, id, payload);
      return await FirestoreService.getById<Role>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteRole(id: string): Promise<{ id: string; message: string }> {
    try {
      const roles = await FirestoreService.getAll<Role>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (roles.length === 0) {
        throw CustomError.notFound("No existe un rol con este id");
      }

      const membershipsUsingRole = await FirestoreService.getAll<BusinessMembership>(
        BUSINESS_MEMBERSHIPS_COLLECTION,
        [{ field: "roleId", operator: "==", value: id }]
      );
      const hasActiveUsage = membershipsUsingRole.some(
        (membership) => membership.status !== "DELETED"
      );
      if (hasActiveUsage) {
        throw CustomError.conflict(
          "No se puede eliminar el rol porque hay usuarios con membresías que lo tienen asignado"
        );
      }
      const role = roles[0]!;

      await FirestoreService.deleteSubcollectionDocuments(
        COLLECTION_NAME,
        id,
        "Permissions"
      );

      const result = await FirestoreService.delete(COLLECTION_NAME, id);
      if (role.type === "BUSINESS" && role.businessId?.trim()) {
        await this.businessUsageLimitService.release(role.businessId, "roles", 1);
      }

      return result;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async resolvePermissionOperations(
    operations: PermissionUpdateOperationDto[]
  ): Promise<Array<{ op: "add" | "remove"; permission: Permission }>> {
    const resolved: Array<{ op: "add" | "remove"; permission: Permission }> = [];

    for (const [index, operation] of operations.entries()) {
      const permissions = await FirestoreService.getAll<Permission>(
        PERMISSIONS_COLLECTION,
        [{ field: "id", operator: "==", value: operation.permissionId }]
      );
      if (permissions.length === 0) {
        throw CustomError.notFound(
          `No existe un permiso con el id indicado en la posición ${index}`
        );
      }

      const permission = permissions[0]!;

      resolved.push({
        op: operation.op,
        permission,
      });
    }

    return resolved;
  }

  private ensurePermissionsCompatibleWithRoleType(
    roleType: RoleType,
    permissions: Permission[]
  ): void {
    const invalidPermission = permissions.find((permission) => {
      if (isGlobalRoleType(roleType)) {
        return permission.type !== "GLOBAL" && permission.type !== "HYBRID";
      }

      if (isBusinessRoleType(roleType)) {
        return permission.type !== "BUSINESS" && permission.type !== "HYBRID";
      }

      return true;
    });

    if (invalidPermission) {
      throw CustomError.badRequest(
        `El permiso ${invalidPermission.id} no es compatible con el tipo de rol ${roleType}`
      );
    }
  }
}
