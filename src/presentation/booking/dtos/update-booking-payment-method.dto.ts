import { CustomError } from "../../../domain/errors/custom-error";

export const BOOKING_PAYMENT_METHOD_UPDATE_OPTIONS = [
  "CASH",
  "NEQUI",
  "DAVIPLATA",
] as const;

export type UpdateBookingPaymentMethodDto =
  (typeof BOOKING_PAYMENT_METHOD_UPDATE_OPTIONS)[number];

export function validateUpdateBookingPaymentMethodDto(
  body: unknown
): UpdateBookingPaymentMethodDto {
  if (typeof body !== "object" || body == null || Array.isArray(body)) {
    throw CustomError.badRequest(
      "El body debe ser un objeto con la propiedad value"
    );
  }

  const parsedBody = body as Record<string, unknown>;
  const valueRaw = parsedBody.value;

  if (typeof valueRaw !== "string" || valueRaw.trim() === "") {
    throw CustomError.badRequest(
      "value es requerido y debe ser uno de: CASH, NEQUI, DAVIPLATA"
    );
  }

  const value = valueRaw.trim().toUpperCase() as UpdateBookingPaymentMethodDto;
  if (!BOOKING_PAYMENT_METHOD_UPDATE_OPTIONS.includes(value)) {
    throw CustomError.badRequest(
      "value debe ser uno de: CASH, NEQUI, DAVIPLATA"
    );
  }

  return value;
}
