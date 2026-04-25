import type { NextFunction, Request, Response } from "express";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import { validateCreateReviewDto, validateReviewIdParam } from "./dtos/review.dto";
import type { ReviewService } from "../services/review.service";
import type { ReviewTargetType } from "../../domain/interfaces/review.interface";
import { CustomError } from "../../domain/errors/custom-error";

function parseTargetType(value: unknown): ReviewTargetType | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw CustomError.badRequest("El tipo de reseña debe ser empleado o sede");
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "") return undefined;
  if (normalized !== "EMPLOYEE" && normalized !== "BRANCH") {
    throw CustomError.badRequest("El tipo de reseña debe ser empleado o sede");
  }
  return normalized as ReviewTargetType;
}

export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  public create = (req: Request, res: Response, next: NextFunction) => {
    const dto = validateCreateReviewDto(req.body);
    this.reviewService
      .createReview(dto)
      .then((review) => {
        res.status(201).json(review);
      })
      .catch(next);
  };

  public getAll = (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageRaw = req.query.page != null ? Number(req.query.page) : DEFAULT_PAGE;
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
      const id =
        typeof req.query.id === "string" && req.query.id.trim() !== ""
          ? req.query.id.trim()
          : undefined;
      const businessId =
        typeof req.query.businessId === "string" && req.query.businessId.trim() !== ""
          ? req.query.businessId.trim()
          : undefined;
      const branchId =
        typeof req.query.branchId === "string" && req.query.branchId.trim() !== ""
          ? req.query.branchId.trim()
          : undefined;
      const type = parseTargetType(req.query.type ?? req.query.targetType);
      const employeeId =
        typeof req.query.employeeId === "string" && req.query.employeeId.trim() !== ""
          ? req.query.employeeId.trim()
          : undefined;
      const targetId =
        typeof req.query.targetId === "string" && req.query.targetId.trim() !== ""
          ? req.query.targetId.trim()
          : undefined;
      const reviewerId =
        typeof req.query.reviewerId === "string" && req.query.reviewerId.trim() !== ""
          ? req.query.reviewerId.trim()
          : undefined;
      const bookingId =
        typeof req.query.bookingId === "string" && req.query.bookingId.trim() !== ""
          ? req.query.bookingId.trim()
          : undefined;
      const appointmentId =
        typeof req.query.appointmentId === "string" &&
        req.query.appointmentId.trim() !== ""
          ? req.query.appointmentId.trim()
          : undefined;

      this.reviewService
        .getAllReviews({
          page: pageRaw,
          pageSize,
          ...(id != null && { id }),
          ...(businessId != null && { businessId }),
          ...(branchId != null && { branchId }),
          ...(type != null && { type }),
          ...(employeeId != null && { employeeId }),
          ...(targetId != null && { targetId }),
          ...(reviewerId != null && { reviewerId }),
          ...(bookingId != null && { bookingId }),
          ...(appointmentId != null && { appointmentId }),
        })
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Parámetros inválidos";
      res.status(400).json({ message });
    }
  };

  public delete = (req: Request, res: Response, next: NextFunction) => {
    const id = validateReviewIdParam(req.params.id);
    this.reviewService
      .deleteReview(id)
      .then((result) => {
        res.status(200).json(result);
      })
      .catch(next);
  };
}
