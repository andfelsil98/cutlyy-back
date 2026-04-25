import { CustomError } from "../../../domain/errors/custom-error";
import { validateConsecutivePrefix } from "../../../domain/utils/booking-consecutive.utils";
import { validateAndNormalizeStartPeriods } from "../../../domain/utils/usage-period.utils";
import { normalizeSpaces, removeAccents } from "../../../domain/utils/string.utils";

export const BUSINESS_TYPES = ["BARBERSHOP", "HAIRSALON", "BEAUTYSALON"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export interface CreateBusinessDto {
  name: string;
  type: BusinessType;
  planId: string;
  startPeriods: string[];
  consecutivePrefix: string;
  logoUrl?: string;
}

export function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === "string" && BUSINESS_TYPES.includes(value as BusinessType);
}

export function validateCreateBusinessDto(body: unknown): CreateBusinessDto {
  if (body == null || typeof body !== "object") {
    throw CustomError.badRequest("El body debe ser un objeto");
  }
  const b = body as Record<string, unknown>;
  const nameRaw = b.name;
  if (typeof nameRaw !== "string") {
    throw CustomError.badRequest("name es requerido y debe ser un texto no vacío");
  }
  const nameNormalized = normalizeSpaces(nameRaw);
  if (nameNormalized === "") {
    throw CustomError.badRequest("name es requerido y debe ser un texto no vacío");
  }
  const sanitizedName = normalizeSpaces(
    removeAccents(nameNormalized).replace(/[^a-zA-Z0-9\s]/g, " ")
  );
  if (sanitizedName === "") {
    throw CustomError.badRequest(
      "name debe tener al menos una letra o número luego de limpiar caracteres especiales"
    );
  }
  const name = sanitizedName.toUpperCase();
  const type = b.type;
  if (!isBusinessType(type)) {
    throw CustomError.badRequest(
      "El tipo de negocio debe ser barbería, peluquería o salón de belleza"
    );
  }
  const planIdRaw = b.planId;
  if (typeof planIdRaw !== "string" || planIdRaw.trim() === "") {
    throw CustomError.badRequest("planId es requerido y debe ser un texto no vacío");
  }
  const subscriptionStatusRaw = b.subscriptionStatus;
  if (subscriptionStatusRaw !== undefined) {
    throw CustomError.badRequest(
      "subscriptionStatus no debe enviarse al crear un negocio"
    );
  }
  const startPeriods = validateAndNormalizeStartPeriods(b.startPeriods, "startPeriods");
  const consecutivePrefix = validateConsecutivePrefix(b.consecutivePrefix);
  const logoUrlRaw = b.logoUrl;
  if (logoUrlRaw !== undefined && typeof logoUrlRaw !== "string") {
    throw CustomError.badRequest("logoUrl debe ser un texto cuando se proporcione");
  }
  const logoUrl =
    logoUrlRaw !== undefined ? normalizeSpaces(String(logoUrlRaw)) : undefined;
  return {
    name,
    type,
    planId: planIdRaw.trim(),
    startPeriods,
    consecutivePrefix,
    ...(logoUrl !== undefined && logoUrl !== "" && { logoUrl }),
  };
}
