import { CustomError } from "../../../domain/errors/custom-error";
import { normalizeSpaces } from "../../../domain/utils/string.utils";

export const PLAN_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_BILLING_INTERVALS = ["MONTHLY", "QUARTERLY", "YEARLY"] as const;
export type PlanBillingInterval = (typeof PLAN_BILLING_INTERVALS)[number];

export interface CreatePlanDto {
  name: string;
  description: string;
  status: PlanStatus;
  billingInterval: PlanBillingInterval;
  maxEmployees: number;
  maxBranches: number;
  maxBookings: number;
  maxRoles: number;
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && PLAN_STATUSES.includes(value as PlanStatus);
}

export function isPlanBillingInterval(value: unknown): value is PlanBillingInterval {
  return (
    typeof value === "string" &&
    PLAN_BILLING_INTERVALS.includes(value as PlanBillingInterval)
  );
}

function validateRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw CustomError.badRequest(`${field} es requerido y debe ser un texto no vacío`);
  }

  const normalized = normalizeSpaces(value);
  if (normalized === "") {
    throw CustomError.badRequest(`${field} es requerido y debe ser un texto no vacío`);
  }

  return normalized;
}

function validateNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw CustomError.badRequest(
      `${field} es requerido y debe ser un entero mayor o igual a 0`
    );
  }

  return value;
}

export function validateCreatePlanDto(body: unknown): CreatePlanDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const b = body as Record<string, unknown>;
  const status = b.status;
  const billingInterval = b.billingInterval;

  if (!isPlanStatus(status)) {
    throw CustomError.badRequest(
      "El estado es requerido y debe ser activo o inactivo"
    );
  }

  if (!isPlanBillingInterval(billingInterval)) {
    throw CustomError.badRequest(
      "El intervalo de facturación es requerido y debe ser mensual, trimestral o anual"
    );
  }

  return {
    name: validateRequiredText(b.name, "name"),
    description: validateRequiredText(b.description, "description"),
    status,
    billingInterval,
    maxEmployees: validateNonNegativeInteger(b.maxEmployees, "maxEmployees"),
    maxBranches: validateNonNegativeInteger(b.maxBranches, "maxBranches"),
    maxBookings: validateNonNegativeInteger(b.maxBookings, "maxBookings"),
    maxRoles: validateNonNegativeInteger(b.maxRoles, "maxRoles"),
  };
}
