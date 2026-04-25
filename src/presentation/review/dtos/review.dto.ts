import { CustomError } from "../../../domain/errors/custom-error";
import { normalizeSpaces } from "../../../domain/utils/string.utils";
import type { ReviewTargetType } from "../../../domain/interfaces/review.interface";

export interface CreateReviewDto {
  businessId: string;
  branchId?: string;
  targetType: ReviewTargetType;
  targetId: string;
  score: number;
  comment?: string;
  reviewerId: string;
  reviewerName: string;
  bookingId: string;
  appointmentId?: string;
}

export function validateReviewIdParam(id: unknown): string {
  if (id == null || typeof id !== "string" || id.trim() === "") {
    throw CustomError.badRequest("El parámetro id es requerido y debe ser un texto no vacío");
  }
  return id.trim();
}

function validateTargetType(raw: unknown): ReviewTargetType {
  if (raw !== "EMPLOYEE" && raw !== "BRANCH") {
    throw CustomError.badRequest("El tipo de reseña debe ser empleado o sede");
  }
  return raw;
}

function validateRequiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw CustomError.badRequest(`${fieldName} es requerido y debe ser un texto no vacío`);
  }
  return value.trim();
}

export function validateCreateReviewDto(body: unknown): CreateReviewDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const b = body as Record<string, unknown>;

  const businessId = validateRequiredText(b.businessId, "businessId");
  const targetType = validateTargetType(b.targetType);
  const targetId = validateRequiredText(b.targetId, "targetId");
  const reviewerId = validateRequiredText(b.reviewerId, "reviewerId");
  const reviewerName = normalizeSpaces(
    validateRequiredText(b.reviewerName, "reviewerName")
  );
  const bookingId = validateRequiredText(b.bookingId, "bookingId");

  let branchId: string | undefined;
  if (targetType === "BRANCH") {
    branchId = validateRequiredText(b.branchId, "branchId");
  } else if (typeof b.branchId === "string" && b.branchId.trim() !== "") {
    branchId = b.branchId.trim();
  }

  if (typeof b.score !== "number" || Number.isNaN(b.score)) {
    throw CustomError.badRequest("score es requerido y debe ser un número");
  }
  if (!Number.isInteger(b.score) || b.score < 1 || b.score > 5) {
    throw CustomError.badRequest("score debe ser un entero entre 1 y 5");
  }
  const score = b.score;

  let appointmentId: string | undefined;
  if (b.appointmentId !== undefined) {
    appointmentId = validateRequiredText(b.appointmentId, "appointmentId");
  }

  if (targetType === "EMPLOYEE" && !appointmentId) {
    throw CustomError.badRequest(
      "La cita es requerida cuando la reseña es para un empleado"
    );
  }

  let comment: string | undefined;
  if (b.comment !== undefined) {
    if (typeof b.comment !== "string") {
      throw CustomError.badRequest("comment debe ser texto cuando se proporcione");
    }
    const normalizedComment = normalizeSpaces(b.comment);
    if (normalizedComment !== "") {
      comment = normalizedComment;
    }
  }

  return {
    businessId,
    ...(branchId !== undefined && { branchId }),
    targetType,
    targetId,
    score,
    ...(comment !== undefined && { comment }),
    reviewerId,
    reviewerName,
    bookingId,
    ...(appointmentId !== undefined && { appointmentId }),
  };
}
