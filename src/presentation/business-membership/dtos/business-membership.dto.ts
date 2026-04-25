import { CustomError } from "../../../domain/errors/custom-error";
import {
  BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES,
  type BusinessMembershipQueryableStatus,
} from "../../../domain/interfaces/business-membership.interface";

export interface AssignRoleDto {
  membershipId: string;
  roleId: string;
}

export interface AssignBranchDto {
  membershipId: string;
  branchId: string;
}

export interface CreatePendingMembershipByDocumentDto {
  document: string;
  businessId?: string;
}

export function validateBusinessIdHeader(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw CustomError.badRequest(
      "El header businessId es requerido y debe ser un texto no vacío"
    );
  }
  return value.trim();
}

export function validateMembershipIdParam(id: unknown): string {
  if (id == null || typeof id !== "string" || id.trim() === "") {
    throw CustomError.badRequest(
      "El parámetro id es requerido y debe ser un texto no vacío"
    );
  }
  return id.trim();
}

export function validateMembershipStatusQuery(
  value: unknown
): BusinessMembershipQueryableStatus | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw CustomError.badRequest(
      "status debe ser un texto no vacío cuando se proporcione"
    );
  }

  const normalizedStatus = value.trim().toUpperCase();
  if (
    !BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES.includes(
      normalizedStatus as BusinessMembershipQueryableStatus
    )
  ) {
    throw CustomError.badRequest(
      "El estado debe ser activo, inactivo o pendiente cuando se proporcione"
    );
  }

  return normalizedStatus as BusinessMembershipQueryableStatus;
}

export function validateAssignRoleDto(body: unknown): AssignRoleDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }
  const b = body as Record<string, unknown>;

  const membershipIdRaw = b.membershipId;
  if (typeof membershipIdRaw !== "string" || membershipIdRaw.trim() === "") {
    throw CustomError.badRequest(
      "membershipId es requerido y debe ser un texto no vacío"
    );
  }

  const roleIdRaw = b.roleId;
  if (typeof roleIdRaw !== "string" || roleIdRaw.trim() === "") {
    throw CustomError.badRequest(
      "roleId es requerido y debe ser un texto no vacío"
    );
  }

  return {
    membershipId: membershipIdRaw.trim(),
    roleId: roleIdRaw.trim(),
  };
}

export function validateAssignBranchDto(body: unknown): AssignBranchDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const b = body as Record<string, unknown>;

  const membershipIdRaw = b.membershipId;
  if (typeof membershipIdRaw !== "string" || membershipIdRaw.trim() === "") {
    throw CustomError.badRequest(
      "membershipId es requerido y debe ser un texto no vacío"
    );
  }

  const branchIdRaw = b.branchId;
  if (typeof branchIdRaw !== "string" || branchIdRaw.trim() === "") {
    throw CustomError.badRequest(
      "branchId es requerido y debe ser un texto no vacío"
    );
  }

  return {
    membershipId: membershipIdRaw.trim(),
    branchId: branchIdRaw.trim(),
  };
}

export function validateCreatePendingMembershipByDocumentDto(
  body: unknown
): CreatePendingMembershipByDocumentDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const b = body as Record<string, unknown>;

  const documentRaw = b.document;
  if (typeof documentRaw !== "string" || documentRaw.trim() === "") {
    throw CustomError.badRequest(
      "document es requerido y debe ser un texto no vacío"
    );
  }

  const businessIdRaw = b.businessId;
  let businessId: string | undefined;
  if (businessIdRaw !== undefined) {
    if (typeof businessIdRaw !== "string" || businessIdRaw.trim() === "") {
      throw CustomError.badRequest(
        "businessId debe ser un texto no vacío cuando se proporcione"
      );
    }
    businessId = businessIdRaw.trim();
  }

  if (b.businessName !== undefined) {
    throw CustomError.badRequest(
      "businessName ya no es soportado; usa businessId cuando quieras crear la membresía para un negocio específico"
    );
  }

  return {
    document: documentRaw.trim(),
    ...(businessId !== undefined && { businessId }),
  };
}
