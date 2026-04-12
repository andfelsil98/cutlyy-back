import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { isAccessEntityType } from "../../domain/constants/access-control.constants";
import { CustomError } from "../../domain/errors/custom-error";
import type { Module } from "../../domain/interfaces/module.interface";
import type { Permission } from "../../domain/interfaces/permission.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import {
  MAX_PAGE_SIZE,
  buildPagination,
} from "../../domain/interfaces/pagination.interface";
import FirestoreService from "./firestore.service";
import type { CreateModuleDto } from "../module/dtos/create-module.dto";

const COLLECTION_NAME = "Modules";
const PERMISSIONS_COLLECTION = "Permissions";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
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

export class ModuleService {
  async getAllModules(
    params: PaginationParams & { type?: string; types?: string[] }
  ): Promise<PaginatedResult<Module>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const requestedTypes = normalizeRequestedTypes(params.type, params.types);

      if (requestedTypes.length === 0) {
        return await FirestoreService.getAllPaginated<Module>(COLLECTION_NAME, {
          page,
          pageSize,
        });
      }

      if (requestedTypes.length === 1) {
        return await FirestoreService.getAllPaginated<Module>(
          COLLECTION_NAME,
          { page, pageSize },
          [{ field: "type" as const, operator: "==" as const, value: requestedTypes[0]! }]
        );
      }

      const modules = await FirestoreService.getAll<Module>(COLLECTION_NAME, [
        { field: "type", operator: "in", value: requestedTypes },
      ]);

      modules.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

      const total = modules.length;
      const offset = (page - 1) * pageSize;
      const data = modules.slice(offset, offset + pageSize);

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

  async createModule(dto: CreateModuleDto): Promise<Module> {
    try {
      const existingModules = await FirestoreService.getAll<Module>(COLLECTION_NAME);
      const nameKey = toNameKey(dto.name);
      const duplicated = existingModules.some(
        (module) => toNameKey(module.name) === nameKey
      );
      if (duplicated) {
        throw CustomError.conflict("Ya existe un módulo con este nombre");
      }

      const data = {
        name: dto.name,
        value: dto.value,
        type: dto.type,
        ...(dto.description !== undefined && { description: dto.description }),
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };

      const result = await FirestoreService.create(COLLECTION_NAME, data);
      return result as Module;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteModule(id: string): Promise<{ id: string; message: string }> {
    try {
      const modules = await FirestoreService.getAll<Module>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (modules.length === 0) {
        throw CustomError.notFound("No existe un módulo con este id");
      }

      const linkedPermissions = await FirestoreService.getAll<Permission>(
        PERMISSIONS_COLLECTION,
        [{ field: "moduleId", operator: "==", value: id }]
      );
      if (linkedPermissions.length > 0) {
        throw CustomError.conflict(
          "No se puede eliminar el módulo porque tiene permisos asociados"
        );
      }

      return await FirestoreService.delete(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }
}
