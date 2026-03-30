import { Router } from "express";
import { envs } from "../../config/envs";
import { createGoogleCloudTasksQueueProvider } from "../../infrastructure/tasks/google-cloud-tasks.factory";
import { createWhatsAppService } from "../../infrastructure/whatsapp/whatsapp.service.factory";
import { AppointmentController } from "./appointment.controller";
import { AppointmentService } from "../services/appointment.service";
import { AppointmentStatusTaskSchedulerService } from "../services/appointment-status-task-scheduler.service";
import { PushNotificationService } from "../services/push-notification.service";

export class AppointmentRoutes {
  static get routes(): Router {
    const router = Router();

    const cloudTasksProvider = createGoogleCloudTasksQueueProvider();
    const appointmentStatusTaskScheduler =
      new AppointmentStatusTaskSchedulerService(cloudTasksProvider, {
        targetBaseUrl: envs.CLOUD_TASKS_TARGET_BASE_URL,
        internalToken: envs.CLOUD_TASKS_INTERNAL_TOKEN,
      });
    const whatsAppService = createWhatsAppService();
    const pushNotificationService = new PushNotificationService();

    const appointmentService = new AppointmentService(
      undefined,
      appointmentStatusTaskScheduler,
      undefined,
      undefined,
      whatsAppService,
      pushNotificationService
    );
    const appointmentController = new AppointmentController(appointmentService);

    router.get("/", appointmentController.getAll);
    router.post("/", appointmentController.create);
    router.put("/:id", appointmentController.update);
    router.delete("/:id", appointmentController.delete);

    return router;
  }
}
