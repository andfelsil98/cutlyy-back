import { CustomError } from "../errors/custom-error";
import { normalizeSpaces, removeAccents } from "./string.utils";

const CONSECUTIVE_PREFIX_REGEX = /^[A-Z0-9]{1,6}$/;

export function normalizeConsecutivePrefix(value: unknown): string {
  if (typeof value !== "string") return "";
  return removeAccents(normalizeSpaces(value)).toUpperCase();
}

export function validateConsecutivePrefix(
  value: unknown,
  fieldPath = "consecutivePrefix"
): string {
  if (typeof value !== "string") {
    throw CustomError.badRequest(
      `${fieldPath} es requerido y debe ser un texto no vacío`
    );
  }

  const normalized = normalizeConsecutivePrefix(value);
  if (normalized === "") {
    throw CustomError.badRequest(
      `${fieldPath} es requerido y debe ser un texto no vacío`
    );
  }

  if (!CONSECUTIVE_PREFIX_REGEX.test(normalized)) {
    throw CustomError.badRequest(
      `${fieldPath} debe tener máximo 6 caracteres alfanuméricos en mayúscula`
    );
  }

  return normalized;
}

export function isValidConsecutivePrefix(value: string): boolean {
  return CONSECUTIVE_PREFIX_REGEX.test(value);
}

export function normalizeBookingConsecutive(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeSpaces(value).toUpperCase();
}

export function buildBookingConsecutive(prefix: string, suffix: string): string {
  return `${prefix}-${suffix}`;
}
