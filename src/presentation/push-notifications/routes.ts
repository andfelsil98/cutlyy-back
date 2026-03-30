import { Router } from "express";
import { PushNotificationsController } from "./push-notifications.controller";
import { PushNotificationService } from "../services/push-notification.service";

export class PushNotificationsRoutes {
  static get routes(): Router {
    const router = Router();
    const pushNotificationService = new PushNotificationService();
    const pushNotificationsController = new PushNotificationsController(
      pushNotificationService
    );

    router.post("/subscriptions", pushNotificationsController.upsertSubscription);
    router.delete(
      "/subscriptions/:deviceId",
      pushNotificationsController.deleteSubscription
    );

    return router;
  }
}
