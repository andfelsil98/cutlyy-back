import { CustomError } from "../../../domain/errors/custom-error";
import { normalizeSpaces } from "../../../domain/utils/string.utils";
import {
  isPlanStatus,
  type PlanStatus,
} from "./create-plan.dto";

export interface UpdatePlanDto {
  name?: string;
  description?: string;
  status?: PlanStatus;
  maxEmployees?: number;
  maxBranches?: number;
  maxBookings?: number;
  maxRoles?: number;
}

function validateOptionalText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw CustomError.badRequest(`${field} debe ser un texto no vacío cuando se proporcione`);
  }

  const normalized = normalizeSpaces(value);
  if (normalized === "") {
    throw CustomError.badRequest(`${field} no puede estar vacío`);
  }

  return normalized;
}

function validateOptionalNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw CustomError.badRequest(
      `${field} debe ser un entero mayor o igual a 0 cuando se proporcione`
    );
  }

  return value;
}

export function validateUpdatePlanDto(body: unknown): UpdatePlanDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const b = body as Record<string, unknown>;
  const result: UpdatePlanDto = {};

  if (b.name !== undefined) {
    result.name = validateOptionalText(b.name, "name");
  }

  if (b.description !== undefined) {
    result.description = validateOptionalText(b.description, "description");
  }

  if (b.status !== undefined) {
    if (!isPlanStatus(b.status)) {
      throw CustomError.badRequest(
        "El estado debe ser activo o inactivo"
      );
    }
    result.status = b.status;
  }

  if (b.billingInterval !== undefined) {
    throw CustomError.badRequest("billingInterval no se puede editar");
  }

  if (b.maxEmployees !== undefined) {
    result.maxEmployees = validateOptionalNonNegativeInteger(
      b.maxEmployees,
      "maxEmployees"
    );
  }

  if (b.maxBranches !== undefined) {
    result.maxBranches = validateOptionalNonNegativeInteger(
      b.maxBranches,
      "maxBranches"
    );
  }

  if (b.maxBookings !== undefined) {
    result.maxBookings = validateOptionalNonNegativeInteger(
      b.maxBookings,
      "maxBookings"
    );
  }

  if (b.maxRoles !== undefined) {
    result.maxRoles = validateOptionalNonNegativeInteger(b.maxRoles, "maxRoles");
  }

  if (Object.keys(result).length === 0) {
    throw CustomError.badRequest(
      "Se debe proporcionar al menos un campo (name, description, status, maxEmployees, maxBranches, maxBookings, maxRoles)"
    );
  }

  return result;
}

export function validatePlanIdParam(id: unknown): string {
  if (id == null || typeof id !== "string" || id.trim() === "") {
    throw CustomError.badRequest("El parámetro id es requerido y debe ser un texto no vacío");
  }

  return id.trim();
}
