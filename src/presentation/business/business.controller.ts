import type { NextFunction, Request, Response } from "express";
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import { validateCreateBusinessCompleteDto } from "./dtos/create-business-complete.dto";
import { validateUpdateBusinessDto } from "./dtos/update-business.dto";
import type { BusinessService } from "../services/business.service";
import { envs } from "../../config/envs";
import { CustomError } from "../../domain/errors/custom-error";
import { normalizeConsecutivePrefix } from "../../domain/utils/booking-consecutive.utils";

export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  public getAll = (req: Request, res: Response, next: NextFunction) => {
    const pageRaw = req.query.page != null ? Number(req.query.page) : DEFAULT_PAGE;
    const pageSizeRaw = req.query.pageSize != null ? Number(req.query.pageSize) : DEFAULT_PAGE_SIZE;
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
    const slug =
      typeof req.query.slug === "string" && req.query.slug.trim() !== ""
        ? req.query.slug.trim().toLowerCase()
        : undefined;
    const consecutivePrefix =
      typeof req.query.consecutivePrefix === "string" &&
      req.query.consecutivePrefix.trim() !== ""
        ? normalizeConsecutivePrefix(req.query.consecutivePrefix)
        : undefined;
    this.businessService
      .getAllBusinesses({
        page: pageRaw,
        pageSize,
        ...(id != null && { id }),
        ...(slug != null && { slug }),
        ...(consecutivePrefix != null && { consecutivePrefix }),
      })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public create = (req: Request, res: Response, next: NextFunction) => {
    const email = req.decodedIdToken?.email;
    if (!email) {
      next(CustomError.unauthorized("Token de sesión inválido: email no presente en el token."));
      return;
    }

    if (email !== envs.ROOT_USER_EMAIL) {
      next(CustomError.forbidden("No tienes permisos para crear negocios."));
      return;
    }

    const documentClaimRaw = req.decodedIdToken?.["document"];
    if (typeof documentClaimRaw !== "string" || documentClaimRaw.trim() === "") {
      next(
        CustomError.unauthorized(
          "Token de sesión inválido: claim document no presente en el token."
        )
      );
      return;
    }
    const creatorDocument = documentClaimRaw.trim();

    const dto = validateCreateBusinessCompleteDto(req.body);
    this.businessService
      .createBusinessComplete(dto, { creatorDocument })
      .then((result) => {
        res.status(201).json(result);
      })
      .catch(next);
  };

  public update = (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: "El id del negocio es requerido" });
      return;
    }
    const dto = validateUpdateBusinessDto(req.body);
    this.businessService
      .updateBusiness(id, dto)
      .then((business) => {
        res.status(200).json(business);
      })
      .catch(next);
  };

  public deleteBusiness = (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: "El id del negocio es requerido" });
      return;
    }

    const documentClaimRaw = req.decodedIdToken?.["document"];
    if (typeof documentClaimRaw !== "string" || documentClaimRaw.trim() === "") {
      next(
        CustomError.unauthorized(
          "Token de sesión inválido: claim document no presente en el token."
        )
      );
      return;
    }
    const actorDocument = documentClaimRaw.trim();

    this.businessService
      .deleteBusiness(id, { actorDocument })
      .then((business) => {
        res.status(200).json(business);
      })
      .catch(next);
  };

  public toggleStatus = (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: "El id del negocio es requerido" });
      return;
    }

    const documentClaimRaw = req.decodedIdToken?.["document"];
    if (typeof documentClaimRaw !== "string" || documentClaimRaw.trim() === "") {
      next(
        CustomError.unauthorized(
          "Token de sesión inválido: claim document no presente en el token."
        )
      );
      return;
    }
    const actorDocument = documentClaimRaw.trim();

    this.businessService
      .toggleBusinessStatus(id, { actorDocument })
      .then((business) => {
        res.status(200).json(business);
      })
      .catch(next);
  };
}
