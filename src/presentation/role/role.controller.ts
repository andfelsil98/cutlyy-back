import type { NextFunction, Request, Response } from "express";
import type { RoleService } from "../services/role.service";
import { validateCreateRoleDto } from "./dtos/create-role.dto";
import { validateRoleIdParam, validateUpdateRoleDto } from "./dtos/update-role.dto";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import { AccessControlService } from "../services/access-control.service";

export class RoleController {
  constructor(
    private readonly roleService: RoleService,
    private readonly accessControlService: AccessControlService = new AccessControlService()
  ) {}

  public getAll = (req: Request, res: Response, next: NextFunction) => {
    const pageRaw =
      req.query.page != null ? Number(req.query.page) : DEFAULT_PAGE;
    const pageSizeRaw =
      req.query.pageSize != null
        ? Number(req.query.pageSize)
        : DEFAULT_PAGE_SIZE;

    if (Number.isNaN(pageRaw) || pageRaw < 1) {
      res.status(400).json({ message: "page debe ser un entero positivo" });
      return;
    }
    if (Number.isNaN(pageSizeRaw) || pageSizeRaw < 1) {
      res.status(400).json({ message: "pageSize debe ser un entero positivo" });
      return;
    }

    const pageSize = Math.min(MAX_PAGE_SIZE, pageSizeRaw);

    const businessId =
      typeof req.query.businessId === "string" &&
      req.query.businessId.trim() !== ""
        ? req.query.businessId.trim()
        : undefined;

    const id =
      typeof req.query.id === "string" && req.query.id.trim() !== ""
        ? req.query.id.trim()
        : undefined;

    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";
    const businessIdHeader = req.businessId?.trim() ?? "";

    const getRoleDetail = async () => {
      if (businessIdHeader === "") {
        await this.accessControlService.requireGlobalPermission(
          requesterDocument,
          "core.roles.detail"
        );
      }

      return this.roleService.getRoleWithPermissionsById(id!);
    };

    const getRoles = async () => {
      if (businessIdHeader === "") {
        await this.accessControlService.requireGlobalPermission(
          requesterDocument,
          "core.roles.list"
        );
      }

      return this.roleService.getAllRoles({
        page: pageRaw,
        pageSize,
        ...(businessId != null && { businessId }),
      });
    };

    if (id != null) {
      getRoleDetail()
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
      return;
    }

    getRoles()
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public create = (req: Request, res: Response, next: NextFunction) => {
    const dto = validateCreateRoleDto(req.body);
    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";
    const businessIdHeader = req.businessId?.trim() ?? "";

    const execute = async () => {
      if (businessIdHeader === "") {
        await this.accessControlService.requireGlobalPermission(
          requesterDocument,
          "core.roles.create"
        );
      }
      return this.roleService.createRole(dto);
    };

    execute()
      .then((role) => {
        res.status(201).json(role);
      })
      .catch(next);
  };

  public update = (req: Request, res: Response, next: NextFunction) => {
    const id = validateRoleIdParam(req.params.id);
    const dto = validateUpdateRoleDto(req.body);
    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";
    const businessIdHeader = req.businessId?.trim() ?? "";

    const execute = async () => {
      if (businessIdHeader === "") {
        await this.accessControlService.requireGlobalPermission(
          requesterDocument,
          "core.roles.edit"
        );
      }
      return this.roleService.updateRole(id, dto);
    };

    execute()
      .then((role) => {
        res.status(200).json(role);
      })
      .catch(next);
  };

  public delete = (req: Request, res: Response, next: NextFunction) => {
    const id = validateRoleIdParam(req.params.id);
    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";
    const businessIdHeader = req.businessId?.trim() ?? "";

    const execute = async () => {
      if (businessIdHeader === "") {
        await this.accessControlService.requireGlobalPermission(
          requesterDocument,
          "core.roles.delete"
        );
      }
      return this.roleService.deleteRole(id);
    };

    execute()
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };
}
