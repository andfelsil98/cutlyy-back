import { Router } from "express";
import { PlanController } from "./plan.controller";
import { PlanService } from "../services/plan.service";

export class PlanRoutes {
  static get routes(): Router {
    const router = Router();

    const planService = new PlanService();
    const planController = new PlanController(planService);

    router.get("/", planController.getAll);
    router.get("/:id/status-change-eligibility", planController.getStatusChangeEligibility);
    router.post("/", planController.create);
    router.put("/:id", planController.update);
    router.delete("/:id", planController.deletePlan);

    return router;
  }
}
