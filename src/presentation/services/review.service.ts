import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { Appointment } from "../../domain/interfaces/appointment.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Booking } from "../../domain/interfaces/booking.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import type { Business } from "../../domain/interfaces/business.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE, buildPagination } from "../../domain/interfaces/pagination.interface";
import type { Review, ReviewTargetType } from "../../domain/interfaces/review.interface";
import type { User } from "../../domain/interfaces/user.interface";
import type { CreateReviewDto } from "../review/dtos/review.dto";
import FirestoreService from "./firestore.service";

const COLLECTION_NAME = "Reviews";
const BUSINESSES_COLLECTION = "Businesses";
const BRANCHES_COLLECTION = "Branches";
const BOOKINGS_COLLECTION = "Bookings";
const APPOINTMENTS_COLLECTION = "Appointments";
const USERS_COLLECTION = "Users";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";

export class ReviewService {
  async createReview(dto: CreateReviewDto): Promise<Review> {
    try {
      const [business, branch, booking, reviewer] = await Promise.all([
        this.getBusinessOrFail(dto.businessId),
        this.getBranchOrFail(dto.branchId),
        this.getBookingOrFail(dto.bookingId),
        this.getReviewerOrFail(dto.reviewerId),
      ]);

      this.ensureBusinessBranchBookingConsistency({
        business,
        branch,
        booking,
        businessId: dto.businessId,
        branchId: dto.branchId,
      });

      let appointment: Appointment | null = null;
      if (dto.appointmentId) {
        await this.ensureNoReviewExistsForAppointment(dto.appointmentId);
        appointment = await this.getAppointmentOrFail(dto.appointmentId);
        this.ensureAppointmentBelongsToBooking(appointment, booking);
      }

      this.ensureTargetConsistency({
        targetType: dto.targetType,
        targetId: dto.targetId,
        branch,
        appointment,
      });

      const payload = {
        businessId: dto.businessId,
        branchId: dto.branchId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        score: dto.score,
        ...(dto.comment !== undefined && { comment: dto.comment }),
        reviewerId: reviewer.document,
        bookingId: dto.bookingId,
        ...(dto.appointmentId !== undefined && { appointmentId: dto.appointmentId }),
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };

      const created = await FirestoreService.create(COLLECTION_NAME, payload);
      if (dto.targetType === "EMPLOYEE") {
        await this.incrementEmployeeMembershipScore(dto.businessId, dto.targetId, dto.score);
      }
      if (dto.targetType === "BRANCH") {
        await this.incrementBranchScore(dto.businessId, dto.branchId, dto.score);
      }
      return created as Review;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async getAllReviews(
    params: PaginationParams & {
      id?: string;
      businessId?: string;
      branchId?: string;
      type?: ReviewTargetType;
      employeeId?: string;
      targetId?: string;
      reviewerId?: string;
      bookingId?: string;
      appointmentId?: string;
    }
  ): Promise<PaginatedResult<Review>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const requestedType = params.type;
      const requestedEmployeeId =
        params.employeeId != null && params.employeeId.trim() !== ""
          ? params.employeeId.trim()
          : undefined;
      const requestedTargetId =
        params.targetId != null && params.targetId.trim() !== ""
          ? params.targetId.trim()
          : undefined;

      if (requestedType === "BRANCH" && requestedEmployeeId != null) {
        return {
          data: [],
          total: 0,
          pagination: buildPagination(page, pageSize, 0),
        };
      }

      const filters = [
        ...(params.id != null && params.id.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.id.trim() }]
          : []),
        ...(params.businessId != null && params.businessId.trim() !== ""
          ? [
              {
                field: "businessId" as const,
                operator: "==" as const,
                value: params.businessId.trim(),
              },
            ]
          : []),
        ...(params.branchId != null && params.branchId.trim() !== ""
          ? [
              {
                field: "branchId" as const,
                operator: "==" as const,
                value: params.branchId.trim(),
              },
            ]
          : []),
        ...(requestedType != null
          ? [
              {
                field: "targetType" as const,
                operator: "==" as const,
                value: requestedType,
              },
            ]
          : []),
        ...(requestedEmployeeId != null
          ? [
              {
                field: "targetType" as const,
                operator: "==" as const,
                value: "EMPLOYEE",
              },
              {
                field: "targetId" as const,
                operator: "==" as const,
                value: requestedEmployeeId,
              },
            ]
          : []),
        ...(requestedTargetId != null
          ? [
              {
                field: "targetId" as const,
                operator: "==" as const,
                value: requestedTargetId,
              },
            ]
          : []),
        ...(params.reviewerId != null && params.reviewerId.trim() !== ""
          ? [
              {
                field: "reviewerId" as const,
                operator: "==" as const,
                value: params.reviewerId.trim(),
              },
            ]
          : []),
        ...(params.bookingId != null && params.bookingId.trim() !== ""
          ? [
              {
                field: "bookingId" as const,
                operator: "==" as const,
                value: params.bookingId.trim(),
              },
            ]
          : []),
        ...(params.appointmentId != null && params.appointmentId.trim() !== ""
          ? [
              {
                field: "appointmentId" as const,
                operator: "==" as const,
                value: params.appointmentId.trim(),
              },
            ]
          : []),
      ];

      const result = await FirestoreService.getAllPaginated<Review>(
        COLLECTION_NAME,
        { page, pageSize },
        filters
      );
      return result as PaginatedResult<Review>;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteReview(id: string): Promise<{ id: string; message: string }> {
    try {
      const review = await FirestoreService.getById<Review>(COLLECTION_NAME, id);
      const result = await FirestoreService.delete(COLLECTION_NAME, id);

      if (review.targetType === "EMPLOYEE") {
        await this.decrementEmployeeMembershipScore(
          review.businessId,
          review.targetId,
          review.score
        );
      }
      if (review.targetType === "BRANCH") {
        await this.decrementBranchScore(review.businessId, review.branchId, review.score);
      }

      return result;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteReviewsByAppointmentId(appointmentId: string): Promise<void> {
    const reviews = await FirestoreService.getAll<Review>(COLLECTION_NAME, [
      { field: "appointmentId", operator: "==", value: appointmentId },
    ]);
    await Promise.all(reviews.map((review) => this.deleteReviewWithData(review)));
  }

  async deleteReviewsByAppointmentIds(appointmentIds: string[]): Promise<void> {
    const uniqueAppointmentIds = Array.from(
      new Set(
        appointmentIds
          .map((appointmentId) => appointmentId.trim())
          .filter((appointmentId) => appointmentId !== "")
      )
    );
    if (uniqueAppointmentIds.length === 0) return;

    const CHUNK_SIZE = 30;
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueAppointmentIds.length; i += CHUNK_SIZE) {
      chunks.push(uniqueAppointmentIds.slice(i, i + CHUNK_SIZE));
    }

    const results = await Promise.all(
      chunks.map((chunk) =>
        FirestoreService.getAll<Review>(COLLECTION_NAME, [
          { field: "appointmentId", operator: "in", value: chunk },
        ])
      )
    );

    const allReviews = results.flat();
    await Promise.all(allReviews.map((review) => this.deleteReviewWithData(review)));
  }

  private async deleteReviewWithData(review: Review): Promise<void> {
    await FirestoreService.delete(COLLECTION_NAME, review.id);

    if (review.targetType === "EMPLOYEE") {
      await this.decrementEmployeeMembershipScore(
        review.businessId,
        review.targetId,
        review.score
      );
    }
    if (review.targetType === "BRANCH") {
      await this.decrementBranchScore(review.businessId, review.branchId, review.score);
    }
  }

  private async getBusinessOrFail(id: string): Promise<Business> {
    const businesses = await FirestoreService.getAll<Business>(BUSINESSES_COLLECTION, [
      { field: "id", operator: "==", value: id },
    ]);
    if (businesses.length === 0) {
      throw CustomError.notFound("No existe un negocio con este id");
    }
    const business = businesses[0]!;
    if (business.status === "DELETED") {
      throw CustomError.badRequest("No se puede crear una reseña para un negocio eliminado");
    }
    return business;
  }

  private async getBranchOrFail(id: string): Promise<Branch> {
    const branches = await FirestoreService.getAll<Branch>(BRANCHES_COLLECTION, [
      { field: "id", operator: "==", value: id },
    ]);
    if (branches.length === 0) {
      throw CustomError.notFound("No existe una sede con este id");
    }
    const branch = branches[0]!;
    if (branch.status === "DELETED") {
      throw CustomError.badRequest("No se puede crear una reseña para una sede eliminada");
    }
    return branch;
  }

  private async getBookingOrFail(id: string): Promise<Booking> {
    const bookings = await FirestoreService.getAll<Booking>(BOOKINGS_COLLECTION, [
      { field: "id", operator: "==", value: id },
    ]);
    if (bookings.length === 0) {
      throw CustomError.notFound("No existe un booking con este id");
    }
    const booking = bookings[0]!;
    if (booking.status === "DELETED") {
      throw CustomError.badRequest("No se puede crear una reseña para un booking eliminado");
    }
    return booking;
  }

  private async getAppointmentOrFail(id: string): Promise<Appointment> {
    const appointments = await FirestoreService.getAll<Appointment>(APPOINTMENTS_COLLECTION, [
      { field: "id", operator: "==", value: id },
    ]);
    if (appointments.length === 0) {
      throw CustomError.notFound("No existe una cita con este id");
    }
    const appointment = appointments[0]!;
    if (appointment.status === "DELETED") {
      throw CustomError.badRequest("No se puede crear una reseña para una cita eliminada");
    }
    return appointment;
  }

  private async getReviewerOrFail(reviewerId: string): Promise<User> {
    const usersByDocument = await FirestoreService.getAll<User>(USERS_COLLECTION, [
      { field: "document", operator: "==", value: reviewerId },
    ]);
    const reviewer = usersByDocument[0] ?? null;
    if (!reviewer) {
      throw CustomError.notFound(
        "No existe un usuario con este reviewerId (document)"
      );
    }
    return reviewer;
  }

  private ensureBusinessBranchBookingConsistency({
    business,
    branch,
    booking,
    businessId,
    branchId,
  }: {
    business: Business;
    branch: Branch;
    booking: Booking;
    businessId: string;
    branchId: string;
  }): void {
    if (business.id !== businessId) {
      throw CustomError.badRequest("businessId no corresponde al negocio consultado");
    }
    if (branch.id !== branchId) {
      throw CustomError.badRequest("branchId no corresponde a la sede consultada");
    }
    if (branch.businessId !== business.id) {
      throw CustomError.badRequest("La sede enviada no pertenece al negocio enviado");
    }
    if (booking.businessId !== business.id) {
      throw CustomError.badRequest("El booking no pertenece al negocio enviado");
    }
    if (booking.branchId !== branch.id) {
      throw CustomError.badRequest("El booking no pertenece a la sede enviada");
    }
  }

  private ensureAppointmentBelongsToBooking(
    appointment: Appointment,
    booking: Booking
  ): void {
    if (appointment.bookingId !== booking.id) {
      throw CustomError.badRequest(
        "appointmentId no pertenece al booking enviado"
      );
    }
  }

  private ensureTargetConsistency({
    targetType,
    targetId,
    branch,
    appointment,
  }: {
    targetType: ReviewTargetType;
    targetId: string;
    branch: Branch;
    appointment: Appointment | null;
  }): void {
    if (targetType === "BRANCH") {
      if (targetId !== branch.id) {
        throw CustomError.badRequest(
          "Cuando targetType es BRANCH, targetId debe ser igual a branchId"
        );
      }
      return;
    }

    if (!appointment) {
      throw CustomError.badRequest(
        "appointmentId es requerido cuando targetType es EMPLOYEE"
      );
    }

    if (appointment.employeeId !== targetId) {
      throw CustomError.badRequest(
        "Cuando targetType es EMPLOYEE, targetId debe coincidir con employeeId de la cita"
      );
    }
  }

  private async ensureNoReviewExistsForAppointment(
    appointmentId: string
  ): Promise<void> {
    const reviews = await FirestoreService.getAll<Review>(COLLECTION_NAME, [
      { field: "appointmentId", operator: "==", value: appointmentId },
    ]);
    if (reviews.length > 0) {
      throw CustomError.conflict("Ya existe una reseña para esta cita");
    }
  }

  private async incrementEmployeeMembershipScore(
    businessId: string,
    targetId: string,
    reviewScore: number
  ): Promise<void> {
    const membership = await this.getEmployeeMembershipByTarget(
      businessId,
      targetId
    );
    const currentReviews = Math.max(0, membership.reviews ?? 0);
    const currentScore = membership.score ?? 0;
    const nextReviews = currentReviews + 1;
    const nextScore = (currentScore * currentReviews + reviewScore) / nextReviews;

    await FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membership.id, {
      score: nextScore,
      reviews: nextReviews,
      updatedAt: FirestoreDataBase.generateTimeStamp(),
    });
  }

  private async decrementEmployeeMembershipScore(
    businessId: string,
    targetId: string,
    reviewScore: number
  ): Promise<void> {
    const membership = await this.getEmployeeMembershipByTarget(
      businessId,
      targetId
    );
    const currentReviews = Math.max(0, membership.reviews ?? 0);
    const currentScore = membership.score ?? 0;
    const nextReviews = Math.max(0, currentReviews - 1);
    const nextScore =
      nextReviews === 0
        ? 0
        : (currentScore * currentReviews - reviewScore) / nextReviews;

    await FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membership.id, {
      score: nextScore,
      reviews: nextReviews,
      updatedAt: FirestoreDataBase.generateTimeStamp(),
    });
  }

  private async incrementBranchScore(
    businessId: string,
    branchId: string,
    reviewScore: number
  ): Promise<void> {
    const branch = await this.getBranchOrFail(branchId);
    if (branch.businessId !== businessId) {
      throw CustomError.badRequest("La sede enviada no pertenece al negocio enviado");
    }
    const currentReviews = Math.max(0, branch.reviews ?? 0);
    const currentScore = branch.score ?? 0;
    const nextReviews = currentReviews + 1;
    const nextScore = (currentScore * currentReviews + reviewScore) / nextReviews;

    await FirestoreService.update(BRANCHES_COLLECTION, branchId, {
      score: nextScore,
      reviews: nextReviews,
      updatedAt: FirestoreDataBase.generateTimeStamp(),
    });
  }

  private async decrementBranchScore(
    businessId: string,
    branchId: string,
    reviewScore: number
  ): Promise<void> {
    const branch = await this.getBranchOrFail(branchId);
    if (branch.businessId !== businessId) {
      throw CustomError.badRequest("La sede enviada no pertenece al negocio enviado");
    }
    const currentReviews = Math.max(0, branch.reviews ?? 0);
    const currentScore = branch.score ?? 0;
    const nextReviews = Math.max(0, currentReviews - 1);
    const nextScore =
      nextReviews === 0
        ? 0
        : (currentScore * currentReviews - reviewScore) / nextReviews;

    await FirestoreService.update(BRANCHES_COLLECTION, branchId, {
      score: nextScore,
      reviews: nextReviews,
      updatedAt: FirestoreDataBase.generateTimeStamp(),
    });
  }

  private async getEmployeeMembershipByTarget(
    businessId: string,
    targetId: string
  ): Promise<BusinessMembership> {
    const [memberships, usersById, usersByDocument] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(BUSINESS_MEMBERSHIPS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<User>(USERS_COLLECTION, [
        { field: "id", operator: "==", value: targetId },
      ]),
      FirestoreService.getAll<User>(USERS_COLLECTION, [
        { field: "document", operator: "==", value: targetId },
      ]),
    ]);

    const allowedUserIds = new Set<string>([targetId]);
    const userById = usersById[0];
    const userByDocument = usersByDocument[0];
    if (userById) {
      allowedUserIds.add(userById.id);
      allowedUserIds.add(userById.document);
    }
    if (userByDocument) {
      allowedUserIds.add(userByDocument.id);
      allowedUserIds.add(userByDocument.document);
    }

    const membership = memberships.find(
      (item) =>
        item.isEmployee === true &&
        item.status !== "DELETED" &&
        allowedUserIds.has(item.userId)
    );
    if (!membership) {
      throw CustomError.notFound(
        "No existe una membresía de empleado para actualizar score en este negocio"
      );
    }
    return membership;
  }
}
