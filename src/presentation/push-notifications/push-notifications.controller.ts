import type { NextFunction, Request, Response } from "express";
import { CustomError } from "../../domain/errors/custom-error";
import type { PushNotificationService } from "../services/push-notification.service";
import {
  validatePushNotificationDeviceIdParam,
  validateUpsertPushNotificationSubscriptionDto,
} from "./dtos/upsert-push-notification-subscription.dto";

function resolveAuthenticatedUserDocument(req: Request): string {
  const decodedToken = req.decodedIdToken as Record<string, unknown> | undefined;
  const documentRaw = decodedToken?.document;

  if (typeof documentRaw !== "string" || documentRaw.trim() === "") {
    throw CustomError.unauthorized(
      "No se pudo resolver el documento del usuario autenticado",
      "SESSION_DOCUMENT_REQUIRED"
    );
  }

  return documentRaw.trim();
}

export class PushNotificationsController {
  constructor(
    private readonly pushNotificationService: PushNotificationService
  ) {}

  public upsertSubscription = (req: Request, res: Response, next: NextFunction) => {
    try {
      const requesterDocument = resolveAuthenticatedUserDocument(req);
      const dto = validateUpsertPushNotificationSubscriptionDto(req.body);

      this.pushNotificationService
        .upsertSubscription(requesterDocument, dto)
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };

  public deleteSubscription = (req: Request, res: Response, next: NextFunction) => {
    try {
      const requesterDocument = resolveAuthenticatedUserDocument(req);
      const deviceId = validatePushNotificationDeviceIdParam(req.params.deviceId);

      this.pushNotificationService
        .deleteSubscription(requesterDocument, deviceId)
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };
}
