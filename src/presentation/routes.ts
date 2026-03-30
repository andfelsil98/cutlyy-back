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

export class AppRoutes {
  static get routes(): Router {
    const router = Router();
    router.use("/api/auth", AuthRoutes.routes);
    router.use("/api/business", BusinessRoutes.routes);
    router.use("/api/branches", BranchRoutes.routes);
    router.use("/api/services", ServiceRoutes.routes);
    router.use("/api/modules", ModuleRoutes.routes);
    router.use("/api/permissions", PermissionRoutes.routes);
    router.use("/api/roles", RoleRoutes.routes);
    router.use("/api/business-memberships", BusinessMembershipRoutes.routes);
    router.use("/api/users", UsersRoutes.routes);
    router.use("/api/appointments", AppointmentRoutes.routes);
    router.use("/api/bookings", BookingRoutes.routes);
    router.use("/api/reviews", ReviewRoutes.routes);
    router.use("/api/whatsapp", WhatsAppRoutes.routes);
    router.use("/api/metrics", MetricsRoutes.routes);
    router.use("/api/plans", PlanRoutes.routes);
    router.use("/api/push-notifications", PushNotificationsRoutes.routes);
    return router;
  }
}
