import type { NextFunction, Request, Response } from "express";
import type { PermissionService } from "../services/permission.service";
import { validateCreatePermissionDto } from "./dtos/create-permission.dto";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";

function parseOptionalTextQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function parseIdsQuery(value: unknown): string[] | undefined {
  if (value == null) return undefined;

  const rawValues = Array.isArray(value) ? value : [value];
  const ids = rawValues.flatMap((item) => {
    if (typeof item !== "string") {
      throw new Error("ids[] debe contener solo textos");
    }
    return item
      .split(",")
      .map((permissionId) => permissionId.trim())
      .filter((permissionId) => permissionId !== "");
  });

  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    throw new Error("ids[] debe incluir al menos un id válido");
  }

  return uniqueIds;
}

export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  public getAll = (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageRaw =
        req.query.page != null ? Number(req.query.page) : DEFAULT_PAGE;
      const pageSizeRaw =
        req.query.pageSize != null ? Number(req.query.pageSize) : DEFAULT_PAGE_SIZE;

      if (Number.isNaN(pageRaw) || pageRaw < 1) {
        res.status(400).json({ message: "page debe ser un entero positivo" });
        return;
      }
      if (Number.isNaN(pageSizeRaw) || pageSizeRaw < 1) {
        res.status(400).json({ message: "pageSize debe ser un entero positivo" });
        return;
      }

      const pageSize = Math.min(MAX_PAGE_SIZE, pageSizeRaw);
      const id = parseOptionalTextQuery(req.query.id);
      const moduleId = parseOptionalTextQuery(req.query.moduleId);
      const ids = parseIdsQuery(req.query["ids[]"] ?? req.query.ids);

      this.permissionService
        .getAllPermissions({
          page: pageRaw,
          pageSize,
          ...(id != null && { id }),
          ...(moduleId != null && { moduleId }),
          ...(ids != null && { ids }),
        })
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Parámetros inválidos";
      res.status(400).json({ message });
    }
  };

  public create = (req: Request, res: Response, next: NextFunction) => {
    const dto = validateCreatePermissionDto(req.body);
    this.permissionService
      .createPermission(dto)
      .then((permission) => {
        res.status(201).json(permission);
      })
      .catch(next);
  };

  public deletePermission = (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;
    if (!id || id.trim() === "") {
      res.status(400).json({ message: "El parámetro id es requerido y debe ser un texto no vacío" });
      return;
    }

    this.permissionService
      .deletePermission(id.trim())
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };
}
