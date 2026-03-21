import { Router } from "express";
import { envs } from "../../config/envs";
import { createGoogleCloudTasksQueueProvider } from "../../infrastructure/tasks/google-cloud-tasks.factory";
import { createWhatsAppService } from "../../infrastructure/whatsapp/whatsapp.service.factory";
import { AppointmentStatusTaskSchedulerService } from "../services/appointment-status-task-scheduler.service";
import { AppointmentService } from "../services/appointment.service";
import { BookingController } from "./booking.controller";
import { BookingService } from "../services/booking.service";

export class BookingRoutes {
  static get routes(): Router {
    const router = Router();

    const cloudTasksProvider = createGoogleCloudTasksQueueProvider();
    const appointmentStatusTaskScheduler =
      new AppointmentStatusTaskSchedulerService(cloudTasksProvider, {
        targetBaseUrl: envs.CLOUD_TASKS_TARGET_BASE_URL,
        internalToken: envs.CLOUD_TASKS_INTERNAL_TOKEN,
      });

    const appointmentService = new AppointmentService(
      undefined,
      appointmentStatusTaskScheduler
    );
    const whatsAppService = createWhatsAppService();
    const bookingService = new BookingService(
      appointmentService,
      undefined,
      appointmentStatusTaskScheduler,
      whatsAppService
    );
    const bookingController = new BookingController(bookingService);

    router.get("/", bookingController.getAll);
    router.post("/", bookingController.create);
    router.put("/:id", bookingController.update);
    router.delete("/:id", bookingController.delete);

    return router;
  }
}
