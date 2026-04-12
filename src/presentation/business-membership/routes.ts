import { Router } from "express";
import { BusinessMembershipController } from "./business-membership.controller";
import { BusinessMembershipService } from "../services/business-membership.service";
import { RoleService } from "../services/role.service";
import { UserService } from "../services/user.service";

export class BusinessMembershipRoutes {
  static get routes(): Router {
    const router = Router();

    const userService = new UserService();
    const roleService = new RoleService();
    const businessMembershipService = new BusinessMembershipService(
      userService,
      roleService
    );
    const businessMembershipController = new BusinessMembershipController(
      businessMembershipService
    );

    router.get("/public", businessMembershipController.getPublicByBusiness);
    router.get("/", businessMembershipController.getAll);
    router.post(
      "/create-by-document",
      businessMembershipController.createPendingByDocument
    );
    router.patch("/:id/toggle-status", businessMembershipController.toggleStatus);
    router.patch("/:id/toggle-employee", businessMembershipController.toggleEmployee);
    router.post("/assign-role", businessMembershipController.assignRole);
    router.post("/assign-branch", businessMembershipController.assignBranch);

    return router;
  }
}
