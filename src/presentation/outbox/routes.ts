import { Router } from "express";
import { envs } from "../../config/envs";
import { OutboxController } from "./outbox.controller";
import { createOutboxProcessorService } from "./outbox.factory";

export class OutboxRoutes {
  static get routes(): Router {
    const router = Router();

    const outboxProcessorService = createOutboxProcessorService();
    const outboxController = new OutboxController(
      outboxProcessorService,
      envs.CLOUD_TASKS_INTERNAL_TOKEN
    );

    router.get("/", outboxController.list);
    router.get("/:id", outboxController.getById);
    router.post("/process", outboxController.process);
    router.post("/:id/requeue", outboxController.requeue);

    return router;
  }
}
