import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { isAccessEntityType } from "../../domain/constants/access-control.constants";
import { CustomError } from "../../domain/errors/custom-error";
import type { DbFilters } from "../../domain/interfaces/dbFilters.interface";
import type { Permission } from "../../domain/interfaces/permission.interface";
import type { Module } from "../../domain/interfaces/module.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import {
  MAX_PAGE_SIZE,
  buildPagination,
} from "../../domain/interfaces/pagination.interface";
import FirestoreService from "./firestore.service";
import type { CreatePermissionDto } from "../permission/dtos/create-permission.dto";

const COLLECTION_NAME = "Permissions";
const MODULE_COLLECTION = "Modules";
const ROLE_COLLECTION = "Roles";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildModuleFilters(moduleId?: string): DbFilters[] {
  if (moduleId == null || moduleId === "") return [];

  return [{ field: "moduleId", operator: "==" as const, value: moduleId }];
}

function buildTypeFilters(types: string[]): DbFilters[] {
  if (types.length === 0) return [];
  if (types.length === 1) {
    return [{ field: "type", operator: "==" as const, value: types[0]! }];
  }

  return [{ field: "type", operator: "in" as const, value: types }];
}

function normalizeRequestedTypes(type?: string, types?: string[]): string[] {
  const rawValues = [
    ...(typeof type === "string" ? [type] : []),
    ...(Array.isArray(types) ? types : []),
  ];

  return Array.from(
    new Set(
      rawValues
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value !== "" && isAccessEntityType(value))
    )
  );
}

export class PermissionService {
  async getAllPermissions(
    params: PaginationParams & {
      moduleId?: string;
      id?: string;
      ids?: string[];
      type?: string;
      types?: string[];
    }
  ): Promise<PaginatedResult<Permission>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));

      const normalizedId = params.id?.trim();
      const normalizedModuleId = params.moduleId?.trim();
      const normalizedTypes = normalizeRequestedTypes(params.type, params.types);
      const normalizedIds = Array.from(
        new Set(
          (params.ids ?? [])
            .map((permissionId) => permissionId.trim())
            .filter((permissionId) => permissionId !== "")
        )
      );

      if (
        normalizedId == null &&
        normalizedModuleId == null &&
        normalizedTypes.length === 0 &&
        normalizedIds.length === 0
      ) {
        return await FirestoreService.getAllPaginated<Permission>(
          COLLECTION_NAME,
          { page, pageSize }
        );
      }

      let permissions: Permission[] = [];
      if (normalizedId != null && normalizedId !== "") {
        const filters: DbFilters[] = [
          { field: "id", operator: "==" as const, value: normalizedId },
          ...buildTypeFilters(normalizedTypes),
          ...buildModuleFilters(normalizedModuleId),
        ];
        permissions = await FirestoreService.getAll<Permission>(COLLECTION_NAME, filters);
      } else if (normalizedIds.length > 0) {
        const CHUNK_SIZE = 30;
        const chunks: string[][] = [];
        for (let index = 0; index < normalizedIds.length; index += CHUNK_SIZE) {
          chunks.push(normalizedIds.slice(index, index + CHUNK_SIZE));
        }

        const results = await Promise.all(
          chunks.map((chunk) => {
            const filters: DbFilters[] = [
              { field: "id", operator: "in" as const, value: chunk },
              ...buildTypeFilters(normalizedTypes),
              ...buildModuleFilters(normalizedModuleId),
            ];
            return FirestoreService.getAll<Permission>(COLLECTION_NAME, filters);
          })
        );

        const uniquePermissions = new Map<string, Permission>();
        results.flat().forEach((permission) => {
          uniquePermissions.set(permission.id, permission);
        });
        permissions = Array.from(uniquePermissions.values());
      } else {
        const filters: DbFilters[] = [
          ...buildTypeFilters(normalizedTypes),
          ...buildModuleFilters(normalizedModuleId),
        ];
        permissions = await FirestoreService.getAll<Permission>(COLLECTION_NAME, filters);
      }

      permissions.sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
      );

      const total = permissions.length;
      const offset = (page - 1) * pageSize;
      const data = permissions.slice(offset, offset + pageSize);

      return {
        data,
        total,
        pagination: buildPagination(page, pageSize, total),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createPermission(dto: CreatePermissionDto): Promise<Permission> {
    try {
      const existingPermissions = await FirestoreService.getAll<Permission>(
        COLLECTION_NAME
      );
      const nameKey = toNameKey(dto.name);
      const duplicated = existingPermissions.some(
        (permission) => toNameKey(permission.name) === nameKey
      );
      if (duplicated) {
        throw CustomError.conflict("Ya existe un permiso con este nombre");
      }

      const modules = await FirestoreService.getAll<Module>(
        MODULE_COLLECTION,
        [{ field: "id", operator: "==", value: dto.moduleId }]
      );
      if (modules.length === 0) throw CustomError.notFound("No existe un módulo con este id");
      const module = modules[0]!;
      if (module.type !== dto.type) {
        throw CustomError.badRequest(
          "El type del permiso debe coincidir con el type del módulo asociado"
        );
      }

      const data = {
        name: dto.name,
        value: dto.value,
        type: dto.type,
        ...(dto.description !== undefined && { description: dto.description }),
        moduleId: dto.moduleId,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };

      const result = await FirestoreService.create(COLLECTION_NAME, data);
      return result as Permission;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deletePermission(id: string): Promise<{ id: string; message: string }> {
    try {
      const permissions = await FirestoreService.getAll<Permission>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (permissions.length === 0) {
        throw CustomError.notFound("No existe un permiso con este id");
      }

      const roles = await FirestoreService.getAll<{ id: string }>(ROLE_COLLECTION);
      for (const role of roles) {
        const permissionExists = await FirestoreService.subcollectionDocumentExists(
          ROLE_COLLECTION,
          role.id,
          "Permissions",
          id
        );
        if (permissionExists) {
          throw CustomError.conflict(
            "No se puede eliminar el permiso porque está asociado a uno o más roles"
          );
        }
      }

      return await FirestoreService.delete(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }
}
