import type { NextFunction, Request, Response } from "express";
import { CLOUD_TASK_TOKEN_HEADER } from "../../config/cloud-tasks.config";
import { CustomError } from "../../domain/errors/custom-error";
import {
  OUTBOX_EVENT_STATUSES,
  type OutboxEventStatus,
} from "../../domain/interfaces/outbox-event.interface";
import { ExternalDispatchService } from "../services/external-dispatch.service";
import type { OutboxProcessorService } from "../services/outbox-processor.service";
import { OutboxService } from "../services/outbox.service";

export class OutboxController {
  constructor(
    private readonly outboxProcessorService: OutboxProcessorService,
    private readonly internalToken: string,
    private readonly outboxService: OutboxService = new OutboxService(),
    private readonly externalDispatchService: ExternalDispatchService =
      new ExternalDispatchService()
  ) {}

  public list = (req: Request, res: Response, next: NextFunction) => {
    try {
      this.ensureAuthorizedInternalRequest(req);
    } catch (error) {
      next(error);
      return;
    }

    const limit = this.parseOptionalLimit(req.query.limit);
    const status = this.parseOptionalStatus(req.query.status);
    const type = this.parseOptionalText(req.query.type);
    const aggregateType = this.parseOptionalText(req.query.aggregateType);
    const aggregateId = this.parseOptionalText(req.query.aggregateId);

    this.outboxService
      .list({
        ...(limit !== undefined && { limit }),
        ...(status !== undefined && { status }),
        ...(type !== undefined && { type }),
        ...(aggregateType !== undefined && { aggregateType }),
        ...(aggregateId !== undefined && { aggregateId }),
      })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public getById = (req: Request, res: Response, next: NextFunction) => {
    try {
      this.ensureAuthorizedInternalRequest(req);
    } catch (error) {
      next(error);
      return;
    }

    const id = this.parseRequiredParam(req.params.id, "El id del evento de outbox es requerido");

    this.outboxService
      .getById(id)
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public process = (req: Request, res: Response, next: NextFunction) => {
    try {
      this.ensureAuthorizedInternalRequest(req);
    } catch (error) {
      next(error);
      return;
    }

    const limit = this.parseOptionalLimit(req.query.limit);

    this.outboxProcessorService
      .processBatch(limit)
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public requeue = (req: Request, res: Response, next: NextFunction) => {
    try {
      this.ensureAuthorizedInternalRequest(req);
    } catch (error) {
      next(error);
      return;
    }

    const id = this.parseRequiredParam(req.params.id, "El id del evento de outbox es requerido");
    const force = this.parseOptionalBoolean(req.query.force) === true;

    Promise.resolve()
      .then(async () => {
        if (force) {
          await this.externalDispatchService.forceReset(id);
        }
      })
      .then(() => this.outboxService.requeue(id))
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
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

  private parseOptionalLimit(value: unknown): number | undefined {
    if (typeof value !== "string" || value.trim() === "") {
      return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw CustomError.badRequest("limit debe ser un entero positivo");
    }

    return Math.floor(parsed);
  }

  private parseOptionalStatus(value: unknown): OutboxEventStatus | undefined {
    const parsed = this.parseOptionalText(value);
    if (parsed == null) {
      return undefined;
    }

    if (!OUTBOX_EVENT_STATUSES.includes(parsed as OutboxEventStatus)) {
      throw CustomError.badRequest(
        "Estado inválido. Valores permitidos: pendiente, en proceso, completado, con error o pausado"
      );
    }

    return parsed as OutboxEventStatus;
  }

  private parseOptionalText(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value.trim();
    return normalized === "" ? undefined : normalized;
  }

  private parseRequiredParam(value: unknown, errorMessage: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw CustomError.badRequest(errorMessage);
    }

    return value.trim();
  }

  private parseOptionalBoolean(value: unknown): boolean | undefined {
    if (typeof value !== "string" || value.trim() === "") {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }

    throw CustomError.badRequest("force debe ser true o false");
  }
}
