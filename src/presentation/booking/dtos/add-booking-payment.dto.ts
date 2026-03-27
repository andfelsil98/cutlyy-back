import { CustomError } from "../../../domain/errors/custom-error";

export function validateAddBookingPaymentAmount(body: unknown): number {
  if (
    typeof body !== "number" ||
    Number.isNaN(body) ||
    !Number.isFinite(body) ||
    body <= 0
  ) {
    throw CustomError.badRequest(
      "El body debe ser un número mayor a 0 con el valor del abono"
    );
  }

  return body;
}
