import type { NextFunction, Request, Response } from "express";
import { CustomError } from "../../domain/errors/custom-error";
import type { PushNotificationService } from "../services/push-notification.service";
import {
  validatePushNotificationDeviceIdParam,
  validateUpsertPushNotificationSubscriptionDto,
} from "./dtos/upsert-push-notification-subscription.dto";

interface AuthenticatedPushRequester {
  document?: string;
  email?: string;
}

function resolveAuthenticatedPushRequester(req: Request): AuthenticatedPushRequester {
  const decodedToken = req.decodedIdToken as Record<string, unknown> | undefined;
  const documentRaw = decodedToken?.document;
  const emailRaw = decodedToken?.email;

  const document =
    typeof documentRaw === "string" && documentRaw.trim() !== ""
      ? documentRaw.trim()
      : undefined;
  const email =
    typeof emailRaw === "string" && emailRaw.trim() !== ""
      ? emailRaw.trim().toLowerCase()
      : undefined;

  if (document == null && email == null) {
    throw CustomError.unauthorized(
      "No se pudo resolver la identidad del usuario autenticado",
      "SESSION_IDENTITY_REQUIRED"
    );
  }

  return {
    ...(document !== undefined && { document }),
    ...(email !== undefined && { email }),
  };
}

export class PushNotificationsController {
  constructor(
    private readonly pushNotificationService: PushNotificationService
  ) {}

  public upsertSubscription = (req: Request, res: Response, next: NextFunction) => {
    try {
      const requester = resolveAuthenticatedPushRequester(req);
      const dto = validateUpsertPushNotificationSubscriptionDto(req.body);

      this.pushNotificationService
        .upsertSubscription(requester, dto)
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
      const requester = resolveAuthenticatedPushRequester(req);
      const deviceId = validatePushNotificationDeviceIdParam(req.params.deviceId);

      this.pushNotificationService
        .deleteSubscription(requester, deviceId)
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };
}
