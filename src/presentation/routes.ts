import { Router } from "express";
import { AuthRoutes } from "./auth/routes";
import { BranchRoutes } from "./branch/routes";
import { BusinessRoutes } from "./business/routes";
import { ServiceRoutes } from "./service/routes";
import { ModuleRoutes } from "./module/routes";
import { PermissionRoutes } from "./permission/routes";
import { RoleRoutes } from "./role/routes";
import { BusinessMembershipRoutes } from "./business-membership/routes";
import { UsersRoutes } from "./users/routes";
import { AppointmentRoutes } from "./appointment/routes";
import { BookingRoutes } from "./booking/routes";
import { ReviewRoutes } from "./review/routes";
import { WhatsAppRoutes } from "./whatsapp/routes";
import { MetricsRoutes } from "./metrics/routes";
import { PlanRoutes } from "./plan/routes";
import { PushNotificationsRoutes } from "./push-notifications/routes";
import { OutboxRoutes } from "./outbox/routes";

export class AppRoutes {
  static get routes(): Router {
    const router = Router();
    router.use("/auth", AuthRoutes.routes);
    router.use("/business", BusinessRoutes.routes);
    router.use("/branches", BranchRoutes.routes);
    router.use("/services", ServiceRoutes.routes);
    router.use("/modules", ModuleRoutes.routes);
    router.use("/permissions", PermissionRoutes.routes);
    router.use("/roles", RoleRoutes.routes);
    router.use("/business-memberships", BusinessMembershipRoutes.routes);
    router.use("/users", UsersRoutes.routes);
    router.use("/appointments", AppointmentRoutes.routes);
    router.use("/bookings", BookingRoutes.routes);
    router.use("/reviews", ReviewRoutes.routes);
    router.use("/whatsapp", WhatsAppRoutes.routes);
    router.use("/metrics", MetricsRoutes.routes);
    router.use("/plans", PlanRoutes.routes);
    router.use("/push-notifications", PushNotificationsRoutes.routes);
    router.use("/outbox", OutboxRoutes.routes);
    return router;
  }
}
