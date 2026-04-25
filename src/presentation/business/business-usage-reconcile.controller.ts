import type { NextFunction, Request, Response } from "express";
import { CLOUD_TASK_TOKEN_HEADER } from "../../config/cloud-tasks.config";
import { CustomError } from "../../domain/errors/custom-error";
import type { BusinessUsageService } from "../services/business-usage.service";

export class BusinessUsageReconcileController {
  constructor(
    private readonly businessUsageService: BusinessUsageService,
    private readonly internalToken: string
  ) {}

  public reconcileToday = (_req: Request, res: Response, next: NextFunction) => {
    try {
      this.ensureAuthorizedInternalRequest(_req);

      this.businessUsageService
        .reconcileDueUsageTransitionsForToday()
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };

  private ensureAuthorizedInternalRequest(req: Request): void {
    const expectedToken = this.internalToken.trim();
    if (expectedToken === "") {
      throw CustomError.internalServerError(
        "Configuración incompleta para automatización interna"
      );
    }

    const receivedToken = req.header(CLOUD_TASK_TOKEN_HEADER)?.trim() ?? "";
    if (receivedToken === "" || receivedToken !== expectedToken) {
      throw CustomError.unauthorized("Solicitud interna no autorizada");
    }
  }
}
