import type { NextFunction, Request, Response } from "express";
import { CLOUD_TASK_TOKEN_HEADER } from "../../config/cloud-tasks.config";
import { CustomError } from "../../domain/errors/custom-error";
import type { WhatsAppTaskService } from "../services/whatsapp-task.service";
import {
  validateSendWhatsAppMessageByTypeDto,
  validateWhatsAppMessageTypeParam,
} from "./dtos/send-whatsapp-message.dto";

export class WhatsAppController {
  constructor(
    private readonly whatsAppTaskService: WhatsAppTaskService,
    private readonly internalToken: string
  ) {}

  public sendMessage = (req: Request, res: Response, next: NextFunction) => {
    try {
      this.ensureAuthorizedTaskRequest(req);
    } catch (error) {
      next(error);
      return;
    }

    const type = validateWhatsAppMessageTypeParam(req.params.type);
    const dto = validateSendWhatsAppMessageByTypeDto(req.body);

    this.whatsAppTaskService
      .handleTask({
        type,
        appointmentId: dto.appointmentId,
      })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  private ensureAuthorizedTaskRequest(req: Request): void {
    const expectedToken = this.internalToken.trim();
    if (expectedToken === "") {
      throw CustomError.internalServerError(
        "Configuración incompleta para automatización interna"
      );
    }

    const receivedToken = req.header(CLOUD_TASK_TOKEN_HEADER)?.trim() ?? "";
    if (receivedToken === "" || receivedToken !== expectedToken) {
      throw CustomError.unauthorized("Solicitud de automatización no autorizada");
    }
  }
}
