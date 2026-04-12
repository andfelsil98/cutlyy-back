import { Router } from "express";
import { UsersController } from "./users.controller";
import { UserService } from "../services/user.service";

export class UsersRoutes {
  static get routes(): Router {
    const router = Router();
    const userService = new UserService();
    const usersController = new UsersController(userService);

    router.get("/public-lookup", usersController.publicLookup);
    router.get("/", usersController.getAllUsers);
    router.patch("/:id", usersController.updateUser);
    router.delete("/:document", usersController.deleteUser);

    return router;
  }
}
