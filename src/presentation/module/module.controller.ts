import type { NextFunction, Request, Response } from "express";
import type { ModuleService } from "../services/module.service";
import { validateCreateModuleDto } from "./dtos/create-module.dto";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import { CustomError } from "../../domain/errors/custom-error";
import { AccessControlService } from "../services/access-control.service";

function parseTypesQuery(value: unknown): string[] | undefined {
  if (value == null) return undefined;

  const rawValues = Array.isArray(value) ? value : [value];
  const parsedValues = rawValues.flatMap((item) => {
    if (typeof item !== "string") {
      throw new Error("types[] debe contener solo textos");
    }

    return item
      .split(",")
      .map((type) => type.trim())
      .filter((type) => type !== "");
  });

  const uniqueValues = Array.from(new Set(parsedValues));
  return uniqueValues.length > 0 ? uniqueValues : undefined;
}

export class ModuleController {
  constructor(
    private readonly moduleService: ModuleService,
    private readonly accessControlService: AccessControlService = new AccessControlService()
  ) {}

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
      const type =
        typeof req.query.type === "string" && req.query.type.trim() !== ""
          ? req.query.type.trim()
          : undefined;
      const types = parseTypesQuery(req.query["types[]"] ?? req.query.types);
      const requesterDocument =
        typeof req.decodedIdToken?.["document"] === "string"
          ? req.decodedIdToken["document"].trim()
          : "";
      const businessId = req.businessId?.trim() ?? "";

      const execute = async () => {
        if (businessId === "") {
          await this.accessControlService.requireGlobalPermission(
            requesterDocument,
            "core.modules.list"
          );
        }

        return this.moduleService.getAllModules({
          page: pageRaw,
          pageSize,
          ...(type != null && { type }),
          ...(types != null && { types }),
        });
      };

      execute()
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
    const dto = validateCreateModuleDto(req.body);
    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";

    this.accessControlService
      .requireGlobalPermission(requesterDocument, "core.modules.create")
      .then(() => this.moduleService.createModule(dto))
      .then((module) => {
        res.status(201).json(module);
      })
      .catch(next);
  };

  public deleteModule = (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;
    if (!id || id.trim() === "") {
      res.status(400).json({ message: "El parámetro id es requerido y debe ser un texto no vacío" });
      return;
    }

    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";
    if (requesterDocument === "") {
      next(
        CustomError.unauthorized(
          "Token de sesión inválido: claim document no presente en el token."
        )
      );
      return;
    }

    this.accessControlService
      .requireGlobalPermission(requesterDocument, "core.modules.delete")
      .then(() => this.moduleService.deleteModule(id.trim()))
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };
}
