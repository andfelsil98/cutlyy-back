import type { NextFunction, Request, Response } from "express";
import type { BusinessMembershipService } from "../services/business-membership.service";
import { CustomError } from "../../domain/errors/custom-error";
import {
  validateAssignBranchDto,
  validateAssignRoleDto,
  validateCreatePendingMembershipByDocumentDto,
  validateMembershipIdParam,
  validateMembershipStatusQuery,
} from "./dtos/business-membership.dto";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import { AccessControlService } from "../services/access-control.service";

export class BusinessMembershipController {
  constructor(
    private readonly businessMembershipService: BusinessMembershipService,
    private readonly accessControlService: AccessControlService = new AccessControlService()
  ) {}

  private getRequesterDocument(req: Request): string {
    const requesterDocumentRaw = req.decodedIdToken?.["document"];
    if (
      typeof requesterDocumentRaw !== "string" ||
      requesterDocumentRaw.trim() === ""
    ) {
      throw CustomError.unauthorized(
        "Token de sesión inválido: claim document no presente en el token."
      );
    }

    return requesterDocumentRaw.trim();
  }

  private async requireScopedMembershipPermission(
    req: Request,
    membership: {
      id: string;
      businessId?: string | null;
    },
    input: {
      globalPermission: string;
      businessPermission: string;
    }
  ) {
    const requesterDocument = this.getRequesterDocument(req);
    const targetBusinessId = membership.businessId?.trim() ?? "";

    if (targetBusinessId === "") {
      await this.accessControlService.requireGlobalPermission(
        requesterDocument,
        input.globalPermission
      );
      return {
        requesterDocument,
        businessId: "",
      };
    }

    const businessIdHeader = req.businessId?.trim() ?? "";
    if (businessIdHeader === "") {
      throw CustomError.badRequest(
        "Se requiere el header businessId para operar sobre membresías de negocio."
      );
    }
    if (businessIdHeader !== targetBusinessId) {
      throw CustomError.badRequest(
        "El businessId del header no coincide con la membresía a modificar."
      );
    }

    await this.accessControlService.requireBusinessPermission(
      requesterDocument,
      targetBusinessId,
      input.businessPermission
    );

    return {
      requesterDocument,
      businessId: targetBusinessId,
    };
  }

  private async requireBusinessMembershipPermission(
    req: Request,
    membership: {
      businessId?: string | null;
    },
    permissionInput: {
      allOf?: string[];
      anyOf?: string[];
    }
  ) {
    const requesterDocument = this.getRequesterDocument(req);
    const targetBusinessId = membership.businessId?.trim() ?? "";
    if (targetBusinessId === "") {
      throw CustomError.badRequest(
        "Esta acción solo se puede ejecutar sobre membresías de negocio."
      );
    }

    const businessIdHeader = req.businessId?.trim() ?? "";
    if (businessIdHeader === "") {
      throw CustomError.badRequest(
        "Se requiere el header businessId para operar sobre membresías de negocio."
      );
    }
    if (businessIdHeader !== targetBusinessId) {
      throw CustomError.badRequest(
        "El businessId del header no coincide con la membresía a modificar."
      );
    }

    if (permissionInput.allOf && permissionInput.allOf.length > 0) {
      await Promise.all(
        permissionInput.allOf.map((permissionValue) =>
          this.accessControlService.requireBusinessPermission(
            requesterDocument,
            targetBusinessId,
            permissionValue
          )
        )
      );
    }

    if (permissionInput.anyOf && permissionInput.anyOf.length > 0) {
      await this.accessControlService.requireAnyBusinessPermission(
        requesterDocument,
        targetBusinessId,
        permissionInput.anyOf
      );
    }

    return {
      requesterDocument,
      businessId: targetBusinessId,
    };
  }

  public getAll = (req: Request, res: Response, next: NextFunction) => {
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
    const id =
      typeof req.query.id === "string" && req.query.id.trim() !== ""
        ? req.query.id.trim()
        : undefined;
    const email =
      typeof req.query.email === "string" && req.query.email.trim() !== ""
        ? req.query.email.trim()
        : undefined;
    const businessId =
      typeof req.query.businessId === "string" &&
      req.query.businessId.trim() !== ""
        ? req.query.businessId.trim()
        : undefined;
    const branchId =
      typeof req.query.branchId === "string" &&
      req.query.branchId.trim() !== ""
        ? req.query.branchId.trim()
        : undefined;
    const roleId =
      typeof req.query.roleId === "string" && req.query.roleId.trim() !== ""
        ? req.query.roleId.trim()
        : undefined;
    const status = validateMembershipStatusQuery(req.query.status);
    const expandRefsRaw = req.query.expandRefs;
    const expandRefs =
      typeof expandRefsRaw === "string" &&
      expandRefsRaw.trim().toLowerCase() === "true";

    this.businessMembershipService
      .getAllMemberships({
        page: pageRaw,
        pageSize,
        ...(id != null && { id }),
        ...(userId != null && { userId }),
        ...(email != null && { email }),
        ...(businessId != null && { businessId }),
        ...(branchId != null && { branchId }),
        ...(roleId != null && { roleId }),
        ...(status != null && { status }),
        ...(expandRefs && { expandRefs: true }),
      })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public getPublicByBusiness = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const businessId =
      typeof req.query.businessId === "string" &&
      req.query.businessId.trim() !== ""
        ? req.query.businessId.trim()
        : "";

    if (businessId === "") {
      res.status(400).json({ message: "businessId es requerido" });
      return;
    }

    this.businessMembershipService
      .getAllMemberships({
        page: 1,
        pageSize: MAX_PAGE_SIZE,
        businessId,
        status: "ACTIVE",
        expandRefs: true,
      })
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };

  public toggleStatus = (req: Request, res: Response, next: NextFunction) => {
    const id = validateMembershipIdParam(req.params.id);
    const execute = async () => {
      const membership = await this.businessMembershipService.getById(id);
      await this.requireScopedMembershipPermission(req, membership, {
        globalPermission: "core.users.activateOrDeactivate",
        businessPermission: "core.users.activateOrDeactivate",
      });

      return this.businessMembershipService.toggleStatus(id);
    };

    execute()
      .then((membership) => {
        res.status(200).json(membership);
      })
      .catch(next);
  };

  public toggleEmployee = (req: Request, res: Response, next: NextFunction) => {
    const id = validateMembershipIdParam(req.params.id);
    const execute = async () => {
      const membership = await this.businessMembershipService.getById(id);
      await this.requireBusinessMembershipPermission(req, membership, {
        anyOf: [
          "core.users.changeRole",
          "core.users.activateOrDeactivate",
        ],
      });

      return this.businessMembershipService.toggleIsEmployee(id);
    };

    execute()
      .then((membership) => {
        res.status(200).json(membership);
      })
      .catch(next);
  };

  public assignRole = (req: Request, res: Response, next: NextFunction) => {
    const dto = validateAssignRoleDto(req.body);

    const execute = async () => {
      const targetMembership = await this.businessMembershipService.getById(
        dto.membershipId
      );
      const authContext = await this.requireScopedMembershipPermission(
        req,
        targetMembership,
        {
          globalPermission: "core.users.changeRole",
          businessPermission: "core.users.changeRole",
        }
      );

      return this.businessMembershipService.assignRole(dto.membershipId, dto.roleId, {
        ...(authContext.businessId !== "" && { businessId: authContext.businessId }),
        requesterDocument: authContext.requesterDocument,
      });
    };

    execute()
      .then((membership) => {
        res.status(200).json(membership);
      })
      .catch(next);
  };

  public assignBranch = (req: Request, res: Response, next: NextFunction) => {
    const dto = validateAssignBranchDto(req.body);
    const execute = async () => {
      const membership = await this.businessMembershipService.getById(
        dto.membershipId
      );
      await this.requireBusinessMembershipPermission(req, membership, {
        anyOf: [
          "core.users.changeRole",
          "core.users.activateOrDeactivate",
        ],
      });

      return this.businessMembershipService.assignBranch(
        dto.membershipId,
        dto.branchId
      );
    };

    execute()
      .then((membership) => {
        res.status(200).json(membership);
      })
      .catch(next);
  };

  public createPendingByDocument = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const requesterDocument = this.getRequesterDocument(req);
      void this.accessControlService
        .requireGlobalPermission(
          requesterDocument,
          "core.memberships.create"
        )
        .then(() => {
          const dto = validateCreatePendingMembershipByDocumentDto(req.body);

          this.businessMembershipService
            .createPendingByDocument(dto)
            .then((membership) => {
              res.status(201).json(membership);
            })
            .catch(next);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  };
}
