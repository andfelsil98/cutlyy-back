import { CustomError } from "../../../domain/errors/custom-error";
import { validateConsecutivePrefix } from "../../../domain/utils/booking-consecutive.utils";
import {
  normalizeSpaces,
  removeAccents,
  slugFromName,
} from "../../../domain/utils/string.utils";

export const BUSINESS_TYPES = ["BARBERSHOP", "HAIRSALON", "BEAUTYSALON"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export interface CreateBusinessDto {
  name: string;
  type: BusinessType;
  consecutivePrefix: string;
  logoUrl?: string;
  /** Generado a partir de name en validateCreateBusinessDto. */
  slug: string;
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
      `type debe ser uno de: ${BUSINESS_TYPES.join(", ")}`
    );
  }
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
    consecutivePrefix,
    ...(logoUrl !== undefined && logoUrl !== "" && { logoUrl }),
    slug: slugFromName(name),
  };
}
