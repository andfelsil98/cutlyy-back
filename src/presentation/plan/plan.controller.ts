import type { NextFunction, Request, Response } from "express";
import { CustomError } from "../../domain/errors/custom-error";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import type { PlanService } from "../services/plan.service";
import { AccessControlService } from "../services/access-control.service";
import {
  isPlanStatus,
  validateCreatePlanDto,
} from "./dtos/create-plan.dto";
import { validatePlanIdParam, validateUpdatePlanDto } from "./dtos/update-plan.dto";

export class PlanController {
  constructor(
    private readonly planService: PlanService,
    private readonly accessControlService: AccessControlService = new AccessControlService()
  ) {}

  public getAll = (req: Request, res: Response, next: NextFunction) => {
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
    const id =
      typeof req.query.id === "string" && req.query.id.trim() !== ""
        ? req.query.id.trim()
        : undefined;
    const statusRaw =
      typeof req.query.status === "string" && req.query.status.trim() !== ""
        ? req.query.status.trim().toUpperCase()
        : undefined;

    if (statusRaw !== undefined && !isPlanStatus(statusRaw)) {
      res.status(400).json({
        message: "El estado debe ser activo o inactivo",
      });
      return;
    }

    this.planService
      .getAllPlans({
        page: pageRaw,
        pageSize,
        ...(id != null && { id }),
        ...(statusRaw != null && { status: statusRaw }),
      })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public create = (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = this.getRequesterDocument(req);
      const dto = validateCreatePlanDto(req.body);
      this.accessControlService
        .requireGlobalPermission(document, "core.plan.create")
        .then(() => this.planService.createPlan(dto))
        .then((plan) => {
          res.status(201).json(plan);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };

  public update = (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = this.getRequesterDocument(req);
      const id = validatePlanIdParam(req.params.id);
      const dto = validateUpdatePlanDto(req.body);
      this.accessControlService
        .requireGlobalPermission(document, "core.plan.edit")
        .then(() => this.planService.updatePlan(id, dto))
        .then((plan) => {
          res.status(200).json(plan);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };

  public deletePlan = (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = this.getRequesterDocument(req);
      const id = validatePlanIdParam(req.params.id);
      this.accessControlService
        .requireGlobalPermission(document, "core.plan.delete")
        .then(() => this.planService.deletePlan(id))
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };

  private getRequesterDocument(req: Request): string {
    const document = req.decodedIdToken?.["document"];
    if (typeof document !== "string" || document.trim() === "") {
      throw CustomError.unauthorized(
        "Token de sesión inválido: claim document no presente en el token."
      );
    }
    return document.trim();
  }
}
