import type { NextFunction, Request, Response } from "express";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import type { UserService } from "../services/user.service";
import { CustomError } from "../../domain/errors/custom-error";
import { validateUpdateUserDto, validateUserIdParam } from "./dtos/update-user.dto";
import { AccessControlService } from "../services/access-control.service";

export class UsersController {
  constructor(
    private readonly userService: UserService,
    private readonly accessControlService: AccessControlService = new AccessControlService()
  ) {}

  public publicLookup = (req: Request, res: Response, next: NextFunction) => {
    const document =
      typeof req.query.document === "string" && req.query.document.trim() !== ""
        ? req.query.document.trim()
        : undefined;

    if (!document) {
      res.status(400).json({
        message: "document es requerido para la consulta pública de usuarios",
      });
      return;
    }

    this.userService
      .getAllUsers({
        page: 1,
        pageSize: 20,
        document,
      })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public getAllUsers = (req: Request, res: Response, next: NextFunction) => {
    const pageRaw =
      req.query.page != null ? Number(req.query.page) : DEFAULT_PAGE;
    const pageSizeRaw =
      req.query.pageSize != null ? Number(req.query.pageSize) : DEFAULT_PAGE_SIZE;

    if (Number.isNaN(pageRaw) || pageRaw < 1) {
      res.status(400).json({ message: "page debe ser un entero positivo" });
      return;
    }
    if (Number.isNaN(pageSizeRaw) || pageSizeRaw < 1) {
      res.status(400).json({ message: "pageSize debe ser un entero positivo" });
      return;
    }

    const pageSize = Math.min(MAX_PAGE_SIZE, pageSizeRaw);
    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim() !== ""
        ? req.query.userId.trim()
        : undefined;
    const document =
      typeof req.query.document === "string" && req.query.document.trim() !== ""
        ? req.query.document.trim()
        : undefined;
    const name =
      typeof req.query.name === "string" && req.query.name.trim() !== ""
        ? req.query.name.trim()
        : undefined;
    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";

    const execute = async () => {
      const isSelfLookup =
        requesterDocument !== "" &&
        ((document != null && document === requesterDocument) ||
          (userId != null &&
            (await this.userService.getByDocument(requesterDocument))?.id === userId));

      if (!isSelfLookup) {
        await this.accessControlService.requireGlobalPermission(
          requesterDocument,
          "core.users.list"
        );
      }

      return this.userService.getAllUsers({
        page: pageRaw,
        pageSize,
        ...(userId != null && { userId }),
        ...(document != null && { document }),
        ...(name != null && { name }),
      });
    };

    execute()
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public deleteUser = (req: Request, res: Response, next: NextFunction) => {
    const documentRaw = req.params.document;
    if (typeof documentRaw !== "string" || documentRaw.trim() === "") {
      res
        .status(400)
        .json({ message: "El parámetro document es requerido y debe ser un texto no vacío" });
      return;
    }
    const document = documentRaw.trim();

    const deletedByUid = req.uid;
    const deletedByEmail = req.decodedIdToken?.email;

    if (!deletedByUid && !deletedByEmail) {
      next(
        CustomError.unauthorized(
          "No se pudo determinar el usuario responsable de la eliminación"
        )
      );
      return;
    }

    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";
    const deleteOpts = {
      ...(deletedByUid != null && { deletedByUid }),
      ...(deletedByEmail != null && { deletedByEmail }),
    };

    this.accessControlService
      .requireGlobalPermission(requesterDocument, "core.users.delete")
      .then(() => this.userService.deleteUser(document, deleteOpts))
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public updateUser = (req: Request, res: Response, next: NextFunction) => {
    const id = validateUserIdParam(req.params.id);
    const dto = validateUpdateUserDto(req.body);
    const requesterDocument =
      typeof req.decodedIdToken?.["document"] === "string"
        ? req.decodedIdToken["document"].trim()
        : "";

    const execute = async () => {
      const requesterUser =
        requesterDocument !== ""
          ? await this.userService.getByDocument(requesterDocument)
          : null;
      const isSelfUpdate = requesterUser?.id === id;
      if (!isSelfUpdate) {
        await this.accessControlService.requireGlobalPermission(
          requesterDocument,
          "core.users.changeRole"
        );
      }

      return this.userService.updateUser(id, dto);
    };

    execute()
      .then((user) => {
        res.status(200).json(user);
      })
      .catch(next);
  };
}
