import { Router } from "express";
import { envs } from "../../config/envs";
import { createGoogleCloudTasksQueueProvider } from "../../infrastructure/tasks/google-cloud-tasks.factory";
import { AppointmentStatusTaskSchedulerService } from "../services/appointment-status-task-scheduler.service";
import { BusinessUsageReconcileController } from "./business-usage-reconcile.controller";
import { BusinessController } from "./business.controller";
import { BranchService } from "../services/branch.service";
import { BusinessService } from "../services/business.service";
import { BusinessUsageService } from "../services/business-usage.service";
import { ServiceService } from "../services/service.service";
import { UserService } from "../services/user.service";

export class BusinessRoutes {
  static get routes(): Router {
    const router = Router();
    const serviceService = new ServiceService();
    const branchService = new BranchService();
    const userService = new UserService();
    const cloudTasksProvider = createGoogleCloudTasksQueueProvider();
    const appointmentStatusTaskScheduler =
      new AppointmentStatusTaskSchedulerService(cloudTasksProvider, {
        targetBaseUrl: envs.CLOUD_TASKS_TARGET_BASE_URL,
        internalToken: envs.CLOUD_TASKS_INTERNAL_TOKEN,
      });
    const businessUsageService = new BusinessUsageService();
    const businessService = new BusinessService(
      serviceService,
      branchService,
      userService,
      appointmentStatusTaskScheduler,
      businessUsageService
    );
    const businessController = new BusinessController(businessService);
    const businessUsageReconcileController = new BusinessUsageReconcileController(
      businessUsageService,
      envs.CLOUD_TASKS_INTERNAL_TOKEN
    );

    router.get("/", businessController.getAll);
    router.get("/:id/deletion-status", businessController.getDeletionStatus);
    router.post("/", businessController.create);
    router.post(
      "/usage/reconcile-today",
      businessUsageReconcileController.reconcileToday
    );
    router.put("/:id", businessController.update);
    router.patch("/:id/toggle-status", businessController.toggleStatus);
    router.delete("/:id", businessController.deleteBusiness);

    return router;
  }
}
