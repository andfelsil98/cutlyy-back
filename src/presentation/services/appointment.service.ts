import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import type {
  Appointment,
  AppointmentStatus,
} from "../../domain/interfaces/appointment.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Booking, BookingStatus } from "../../domain/interfaces/booking.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import type { Business } from "../../domain/interfaces/business.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import type { Service } from "../../domain/interfaces/service.interface";
import type { User } from "../../domain/interfaces/user.interface";
import { MAX_PAGE_SIZE, buildPagination } from "../../domain/interfaces/pagination.interface";
import type { CreateAppointmentDto } from "../appointment/dtos/create-appointment.dto";
import type { UpdateAppointmentDto } from "../appointment/dtos/update-appointment.dto";
import FirestoreService from "./firestore.service";
import { ensureColombiaCountryCode } from "../../domain/utils/string.utils";
import { ReviewService } from "./review.service";
import type { AppointmentStatusTaskScheduler } from "./appointment-status-task-scheduler.service";
import { logger } from "../../infrastructure/logger/logger";
import { MetricService } from "./metric.service";
import { BookingConsecutiveService } from "./booking-consecutive.service";

const COLLECTION_NAME = "Appointments";
const BOOKINGS_COLLECTION = "Bookings";
const BUSINESS_COLLECTION = "Businesses";
const BRANCH_COLLECTION = "Branches";
const SERVICES_COLLECTION = "Services";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";
const USERS_COLLECTION = "Users";
const ROOT_CLIENT_ID = "JBy4GD7t2XjcoPRWIEkm";

interface AppointmentServiceSelectionStored {
  id: string;
  startTime: string;
  endTime: string;
}

interface ClientData {
  document: string;
  documentTypeId?: string;
  documentTypeName?: string;
  name?: string;
  phone?: string;
  email?: string;
}

interface AppointmentMetricContext {
  businessId: string;
  branchId: string;
  employeeId: string;
  date: string;
  status: AppointmentStatus;
  servicePrice: number;
}

export interface CreateAppointmentForBookingData {
  bookingId: string;
  date: string;
  startTime: string;
  endTime: string;
  serviceId: string;
  employeeId: string;
}

type AppointmentStored = {
  id: string;
  date: Timestamp | string;
  startTime?: string;
  endTime?: string;
  serviceId?: string;
  employeeId?: string;
  status: AppointmentStatus;
  bookingId?: string;
  createdAt: string;
  cancelledAt?: string;
  deletedAt?: string;
  updatedAt?: string;
  // Campos legacy de citas creadas antes del refactor.
  services?: AppointmentServiceSelectionStored[];
  businessId?: string;
  branchId?: string;
  clientId?: string;
  clientDocument?: string;
};

export interface UpdateAppointmentOptions {
  branchIdOverride?: string;
}

export class AppointmentService {
  private validationCache = new Map<string, unknown>();

  constructor(
    private readonly reviewService: ReviewService = new ReviewService(),
    private readonly appointmentStatusTaskScheduler?: AppointmentStatusTaskScheduler,
    private readonly metricService: MetricService = new MetricService(),
    private readonly bookingConsecutiveService: BookingConsecutiveService =
      new BookingConsecutiveService()
  ) {}

  clearValidationCache(): void {
    this.validationCache.clear();
  }

  async getAllAppointments(
    params: PaginationParams & {
      businessId?: string;
      id?: string;
      employeeId?: string;
      bookingId?: string;
      includeDeletes?: boolean;
      startDate?: string;
      endDate?: string;
      sameDate?: boolean;
    }
  ): Promise<PaginatedResult<Appointment>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const includeDeletes = params.includeDeletes === true;
      const hasDateFilters =
        params.startDate != null || params.endDate != null || params.sameDate === true;
      const useSameDate = params.sameDate === true && params.startDate != null;

      const filters = [
        ...(includeDeletes
          ? []
          : [
              {
                field: "status" as const,
                operator: "in" as const,
                value: ["CREATED", "IN_PROGRESS", "CANCELLED", "FINISHED"],
              },
            ]),
        ...(params.id != null && params.id.trim() !== ""
          ? [
              {
                field: "id" as const,
                operator: "==" as const,
                value: params.id.trim(),
              },
            ]
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
        ...(params.employeeId != null && params.employeeId.trim() !== ""
          ? [
              {
                field: "employeeId" as const,
                operator: "==" as const,
                value: params.employeeId.trim(),
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
        ...(useSameDate
          ? [
              {
                field: "date" as const,
                operator: "==" as const,
                value: params.startDate!,
              },
            ]
          : []),
        ...(!useSameDate && params.startDate != null
          ? [
              {
                field: "date" as const,
                operator: ">=" as const,
                value: params.startDate,
              },
            ]
          : []),
        ...(!useSameDate && params.endDate != null
          ? [
              {
                field: "date" as const,
                operator: "<=" as const,
                value: params.endDate,
              },
            ]
          : []),
      ];

      const orderByField = hasDateFilters ? "date" : "createdAt";
      const result = await FirestoreService.getAllPaginated<AppointmentStored>(
        COLLECTION_NAME,
        { page, pageSize },
        filters,
        { field: orderByField, direction: "desc" }
      );
      return {
        ...result,
        data: result.data.map((appointment) =>
          this.mapAppointmentToResponse(appointment)
        ),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createAppointment(dto: CreateAppointmentDto): Promise<Appointment> {
    let createdBookingId: string | null = null;
    let createdAppointmentId: string | null = null;

    try {
      this.ensureAppointmentDateTimeIsNotPast(dto.date, dto.startTime);

      await this.ensureBusinessAndBranch(dto.businessId, dto.branchId);
      const service = await this.ensureServiceExistsInBusiness(
        dto.serviceId,
        dto.businessId
      );

      if (dto.bookingId && dto.bookingId.trim() !== "") {
        const booking = await FirestoreService.getById<Booking>(
          BOOKINGS_COLLECTION,
          dto.bookingId
        );
        if (booking.status !== "CREATED") {
          throw CustomError.badRequest(
            "Solo se pueden agregar citas a bookings con estado CREATED"
          );
        }
        if (booking.businessId !== dto.businessId || booking.branchId !== dto.branchId) {
          throw CustomError.badRequest(
            "El bookingId no corresponde al businessId/branchId enviado"
          );
        }
        if (dto.clientId !== "" && booking.clientId !== dto.clientId) {
          throw CustomError.badRequest(
            "clientId no coincide con el cliente del booking enviado"
          );
        }

        const createdAppointment = await this.createAppointmentForBooking({
          bookingId: booking.id,
          date: dto.date,
          startTime: dto.startTime,
          endTime: dto.endTime,
          serviceId: dto.serviceId,
          employeeId: dto.employeeId,
        });
        createdAppointmentId = createdAppointment.id;

        const nextAppointments = Array.from(
          new Set([...(booking.appointments ?? []), createdAppointment.id])
        );
        const currentTotalAmount =
          Number.isFinite(booking.totalAmount) && booking.totalAmount >= 0
            ? booking.totalAmount
            : 0;
        const currentPaidAmount =
          Number.isFinite(booking.paidAmount) && booking.paidAmount >= 0
            ? booking.paidAmount
            : 0;
        const nextTotalAmount = currentTotalAmount + service.price;

        await FirestoreService.update(BOOKINGS_COLLECTION, booking.id, {
          appointments: nextAppointments,
          totalAmount: nextTotalAmount,
          paymentStatus: this.resolveBookingPaymentStatus(
            nextTotalAmount,
            currentPaidAmount
          ),
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        });

        return createdAppointment;
      }

      await this.ensureClientForBusiness(dto.businessId, {
        document: dto.clientId,
        ...(dto.clientDocumentTypeId !== undefined && {
          documentTypeId: dto.clientDocumentTypeId,
        }),
        ...(dto.clientDocumentTypeName !== undefined && {
          documentTypeName: dto.clientDocumentTypeName,
        }),
        ...(dto.clientName !== undefined && { name: dto.clientName }),
        ...(dto.clientPhone !== undefined && { phone: dto.clientPhone }),
        ...(dto.clientEmail !== undefined && { email: dto.clientEmail }),
      });
      const consecutive = await this.bookingConsecutiveService.generateUniqueConsecutive(
        dto.businessId
      );

      const createdBooking = await FirestoreService.create<{
        businessId: string;
        branchId: string;
        consecutive: string;
        appointments: string[];
        clientId: string;
        status: "CREATED";
        totalAmount: number;
        paymentMethod: "CASH";
        paidAmount: number;
        paymentStatus: "PENDING";
        createdAt: ReturnType<typeof FirestoreDataBase.generateTimeStamp>;
      }>(BOOKINGS_COLLECTION, {
        businessId: dto.businessId,
        branchId: dto.branchId,
        consecutive,
        appointments: [],
        clientId: dto.clientId,
        status: "CREATED",
        totalAmount: service.price,
        paymentMethod: "CASH",
        paidAmount: 0,
        paymentStatus: "PENDING",
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });
      createdBookingId = createdBooking.id;

      const createdAppointment = await this.createAppointmentForBooking({
        bookingId: createdBooking.id,
        date: dto.date,
        startTime: dto.startTime,
        endTime: dto.endTime,
        serviceId: dto.serviceId,
        employeeId: dto.employeeId,
      });
      createdAppointmentId = createdAppointment.id;
      await FirestoreService.update(BOOKINGS_COLLECTION, createdBooking.id, {
        appointments: [createdAppointment.id],
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      await this.scheduleStatusTasksForCreatedAppointment(createdAppointment).catch((taskError) => {
        const detail =
          taskError instanceof Error
            ? taskError.message
            : typeof taskError === "string"
              ? taskError
              : JSON.stringify(taskError);

        logger.warn(
          `[AppointmentService] No se pudieron crear tasks automáticas para appointment ${createdAppointment.id}. detalle=${detail}`
        );
      });

      return createdAppointment;
    } catch (error) {
      const deletedAt = FirestoreDataBase.generateTimeStamp();

      if (createdAppointmentId) {
        await FirestoreService.update(COLLECTION_NAME, createdAppointmentId, {
          status: "DELETED",
          deletedAt,
        }).catch(() => undefined);
      }

      if (createdBookingId) {
        await FirestoreService.update(BOOKINGS_COLLECTION, createdBookingId, {
          appointments: createdAppointmentId ? [createdAppointmentId] : [],
          status: "DELETED",
          deletedAt,
          updatedAt: deletedAt,
        }).catch(() => undefined);
      }

      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createAppointmentForBooking(
    data: CreateAppointmentForBookingData
  ): Promise<Appointment> {
    try {
      this.ensureAppointmentDateTimeIsNotPast(data.date, data.startTime);

      const booking = await FirestoreService.getById<Booking>(
        BOOKINGS_COLLECTION,
        data.bookingId
      );
      if (booking.status === "DELETED") {
        throw CustomError.badRequest(
          "No se puede crear una cita para un booking eliminado"
        );
      }

      const branch = await this.ensureBusinessAndBranch(
        booking.businessId,
        booking.branchId
      );
      const service = await this.ensureServiceExistsInBusiness(
        data.serviceId,
        booking.businessId
      );
      this.ensureTimeRangeWithinBranchSchedule(
        branch,
        data.date,
        data.startTime,
        data.endTime
      );
      await this.ensureEmployeeIsActiveInBusiness(data.employeeId, booking.businessId);
      await this.ensureNoEmployeeScheduleConflict(
        data.employeeId,
        data.date,
        data.startTime,
        data.endTime
      );

      const created = await FirestoreService.create<{
        businessId: string;
        date: string;
        startTime: string;
        endTime: string;
        serviceId: string;
        employeeId: string;
        status: "CREATED";
        bookingId: string;
        createdAt: ReturnType<typeof FirestoreDataBase.generateTimeStamp>;
      }>(COLLECTION_NAME, {
        businessId: booking.businessId,
        date: data.date,
        startTime: data.startTime,
        endTime: data.endTime,
        serviceId: data.serviceId,
        employeeId: data.employeeId,
        status: "CREATED",
        bookingId: data.bookingId,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });

      const createdAppointment = this.mapAppointmentToResponse(
        created as unknown as AppointmentStored
      );

      await this.applyAppointmentMetricTransition(null, {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: data.employeeId,
        date: data.date,
        status: "CREATED",
        servicePrice: service.price,
      });

      return createdAppointment;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async getAppointmentById(id: string): Promise<Appointment> {
    const appointment = await this.getStoredAppointmentById(id);
    return this.mapAppointmentToResponse(appointment);
  }

  async getAppointmentsByIds(ids: string[]): Promise<Appointment[]> {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))
    );
    if (uniqueIds.length === 0) return [];

    const CHUNK_SIZE = 30;
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
      chunks.push(uniqueIds.slice(i, i + CHUNK_SIZE));
    }

    const results = await Promise.all(
      chunks.map((chunk) =>
        FirestoreService.getAll<AppointmentStored>(COLLECTION_NAME, [
          { field: "id", operator: "in", value: chunk },
        ])
      )
    );

    return results
      .flat()
      .map((appointment) => this.mapAppointmentToResponse(appointment));
  }

  async updateAppointment(
    id: string,
    dto: UpdateAppointmentDto,
    opts?: UpdateAppointmentOptions
  ): Promise<Appointment> {
    try {
      this.ensureAppointmentDateTimeIsNotPast(dto.date, dto.startTime);

      const existingAppointment = await this.getStoredAppointmentById(id);
      if (
        existingAppointment.status === "IN_PROGRESS" ||
        existingAppointment.status === "DELETED" ||
        existingAppointment.status === "CANCELLED" ||
        existingAppointment.status === "FINISHED"
      ) {
        throw CustomError.badRequest(
          "No se puede editar una cita con estado IN_PROGRESS, FINISHED, DELETED o CANCELLED"
        );
      }

      const bookingId = existingAppointment.bookingId?.trim() ?? "";
      if (bookingId === "") {
        throw CustomError.badRequest(
          "La cita no está vinculada a un booking y no puede editarse con este flujo"
        );
      }

      const booking = await FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId);
      if (booking.status === "DELETED") {
        throw CustomError.badRequest("No se puede editar una cita de un booking eliminado");
      }

      const branchIdForValidation =
        opts?.branchIdOverride != null && opts.branchIdOverride.trim() !== ""
          ? opts.branchIdOverride.trim()
          : booking.branchId;
      const branch = await this.ensureBusinessAndBranch(
        booking.businessId,
        branchIdForValidation
      );
      const nextService = await this.ensureServiceExistsInBusiness(
        dto.serviceId,
        booking.businessId
      );
      this.ensureTimeRangeWithinBranchSchedule(
        branch,
        dto.date,
        dto.startTime,
        dto.endTime
      );
      await this.ensureEmployeeIsActiveInBusiness(dto.employeeId, booking.businessId);
      await this.ensureNoEmployeeScheduleConflict(
        dto.employeeId,
        dto.date,
        dto.startTime,
        dto.endTime,
        id
      );

      const previousServicePrice = await this.getServicePriceById(
        existingAppointment.serviceId ?? dto.serviceId,
        booking.businessId
      );

      const beforeMetricContext = {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: existingAppointment.employeeId ?? dto.employeeId,
        date: this.normalizeStoredDate(existingAppointment.date, dto.date),
        status: existingAppointment.status,
        servicePrice: previousServicePrice,
      };

      const payload: Record<string, unknown> = {
        date: dto.date,
        startTime: dto.startTime,
        endTime: dto.endTime,
        serviceId: dto.serviceId,
        employeeId: dto.employeeId,
        status: "CREATED",
        // Limpia payload legacy cuando se actualiza por el nuevo esquema.
        services: FieldValue.delete(),
        updatedAt: FirestoreDataBase.generateTimeStamp(),
        cancelledAt: FieldValue.delete(),
        deletedAt: FieldValue.delete(),
      };

      await FirestoreService.update(COLLECTION_NAME, id, payload);
      await this.syncBookingStatusFromAppointments(booking.id);

      await this.applyAppointmentMetricTransition(beforeMetricContext, {
        businessId: booking.businessId,
        branchId: branchIdForValidation,
        employeeId: dto.employeeId,
        date: dto.date,
        status: "CREATED",
        servicePrice: nextService.price,
      });

      const updated = await FirestoreService.getById<AppointmentStored>(
        COLLECTION_NAME,
        id
      );
      const mappedUpdatedAppointment = this.mapAppointmentToResponse(updated);

      await this.rescheduleStatusTasksForAppointment(
        mappedUpdatedAppointment,
        "actualizar"
      );

      return mappedUpdatedAppointment;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async cancelAppointment(id: string): Promise<Appointment> {
    try {
      const existingAppointment = await this.getStoredAppointmentById(id);
      if (existingAppointment.status === "DELETED") {
        throw CustomError.badRequest("No se puede cancelar una cita eliminada");
      }
      if (existingAppointment.status === "FINISHED") {
        throw CustomError.badRequest(
          "No se puede cambiar el estado de una cita finalizada"
        );
      }
      if (existingAppointment.status === "CANCELLED") {
        await this.deleteStatusTasksForAppointment(id, "cancelar");
        return this.mapAppointmentToResponse(existingAppointment);
      }

      const bookingId = existingAppointment.bookingId?.trim() ?? "";
      if (bookingId === "") {
        throw CustomError.badRequest("La cita no está vinculada a un booking");
      }

      const booking = await FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId);
      const beforeServicePrice = await this.getServicePriceById(
        existingAppointment.serviceId ?? "",
        booking.businessId
      );

      await FirestoreService.update(COLLECTION_NAME, id, {
        status: "CANCELLED",
        cancelledAt: FirestoreDataBase.generateTimeStamp(),
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      await this.syncBookingStatusFromAppointments(bookingId);

      await this.applyAppointmentMetricTransition(
        {
          businessId: booking.businessId,
          branchId: booking.branchId,
          employeeId: existingAppointment.employeeId ?? "",
          date: this.normalizeStoredDate(existingAppointment.date),
          status: existingAppointment.status,
          servicePrice: beforeServicePrice,
        },
        {
          businessId: booking.businessId,
          branchId: booking.branchId,
          employeeId: existingAppointment.employeeId ?? "",
          date: this.normalizeStoredDate(existingAppointment.date),
          status: "CANCELLED",
          servicePrice: beforeServicePrice,
        }
      );

      await this.deleteStatusTasksForAppointment(id, "cancelar");

      const cancelled = await this.getStoredAppointmentById(id);
      return this.mapAppointmentToResponse(cancelled);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteAppointment(id: string): Promise<Appointment> {
    try {
      const existingAppointment = await this.getStoredAppointmentById(id);
      if (existingAppointment.status === "DELETED") {
        throw CustomError.badRequest("La cita ya se encuentra eliminada");
      }

      const bookingId = existingAppointment.bookingId?.trim() ?? "";
      if (bookingId === "") {
        throw CustomError.badRequest("La cita no está vinculada a un booking");
      }

      const booking = await FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId);
      const beforeServicePrice = await this.getServicePriceById(
        existingAppointment.serviceId ?? "",
        booking.businessId
      );

      await this.reviewService.deleteReviewsByAppointmentId(id);

      await FirestoreService.update(COLLECTION_NAME, id, {
        status: "DELETED",
        deletedAt: FirestoreDataBase.generateTimeStamp(),
      });

      await this.syncBookingStatusFromAppointments(bookingId);

      await this.applyAppointmentMetricTransition(
        {
          businessId: booking.businessId,
          branchId: booking.branchId,
          employeeId: existingAppointment.employeeId ?? "",
          date: this.normalizeStoredDate(existingAppointment.date),
          status: existingAppointment.status,
          servicePrice: beforeServicePrice,
        },
        null
      );

      await this.deleteStatusTasksForAppointment(id, "eliminar");

      const deleted = await FirestoreService.getById<AppointmentStored>(
        COLLECTION_NAME,
        id
      );
      return this.mapAppointmentToResponse(deleted);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async markAppointmentInProgressIfDue(
    id: string
  ): Promise<{ appointment: Appointment; changed: boolean }> {
    const existing = await this.getStoredAppointmentById(id);
    const mapped = this.mapAppointmentToResponse(existing);

    if (mapped.status !== "CREATED") {
      return { appointment: mapped, changed: false };
    }
    await FirestoreService.update(COLLECTION_NAME, mapped.id, {
      status: "IN_PROGRESS",
      updatedAt: FirestoreDataBase.generateTimeStamp(),
      cancelledAt: FieldValue.delete(),
      deletedAt: FieldValue.delete(),
    });

    const updated = await this.getStoredAppointmentById(mapped.id);
    return {
      appointment: this.mapAppointmentToResponse(updated),
      changed: true,
    };
  }

  async markAppointmentFinishedIfDue(
    id: string
  ): Promise<{ appointment: Appointment; changed: boolean }> {
    const existing = await this.getStoredAppointmentById(id);
    const mapped = this.mapAppointmentToResponse(existing);

    if (mapped.status !== "IN_PROGRESS") {
      return { appointment: mapped, changed: false };
    }

    const bookingId = mapped.bookingId.trim();
    if (bookingId === "") {
      throw CustomError.badRequest("La cita no está vinculada a un booking");
    }

    const booking = await FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId);
    const servicePrice = await this.getServicePriceById(mapped.serviceId, booking.businessId);

    await FirestoreService.update(COLLECTION_NAME, mapped.id, {
      status: "FINISHED",
      updatedAt: FirestoreDataBase.generateTimeStamp(),
      cancelledAt: FieldValue.delete(),
      deletedAt: FieldValue.delete(),
    });

    await this.syncBookingStatusFromAppointments(bookingId);

    await this.applyAppointmentMetricTransition(
      {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: mapped.employeeId,
        date: mapped.date,
        status: "IN_PROGRESS",
        servicePrice,
      },
      {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: mapped.employeeId,
        date: mapped.date,
        status: "FINISHED",
        servicePrice,
      }
    );

    const updated = await this.getStoredAppointmentById(mapped.id);
    return {
      appointment: this.mapAppointmentToResponse(updated),
      changed: true,
    };
  }
  private async applyAppointmentMetricTransition(
    before: AppointmentMetricContext | null,
    after: AppointmentMetricContext | null
  ): Promise<void> {
    const beforeContribution =
      before == null ? null : this.resolveMetricContribution(before.status, before.servicePrice);
    const afterContribution =
      after == null ? null : this.resolveMetricContribution(after.status, after.servicePrice);

    const deltasByContext = new Map<
      string,
      {
        context: AppointmentMetricContext;
        delta: {
          revenueDelta: number;
          appointmentsDelta: number;
          completedAppointmentsDelta: number;
          cancelledAppointmentsDelta: number;
        };
      }
    >();

    if (before != null && beforeContribution != null) {
      this.accumulateMetricDelta(
        deltasByContext,
        before,
        this.negateContribution(beforeContribution)
      );
    }

    if (after != null && afterContribution != null) {
      this.accumulateMetricDelta(deltasByContext, after, afterContribution);
    }

    for (const { context, delta } of deltasByContext.values()) {
      await this.applyMetricDeltaIfNeeded(context, delta);
    }
  }

  private accumulateMetricDelta(
    deltasByContext: Map<
      string,
      {
        context: AppointmentMetricContext;
        delta: {
          revenueDelta: number;
          appointmentsDelta: number;
          completedAppointmentsDelta: number;
          cancelledAppointmentsDelta: number;
        };
      }
    >,
    context: AppointmentMetricContext,
    delta: {
      revenueDelta: number;
      appointmentsDelta: number;
      completedAppointmentsDelta: number;
      cancelledAppointmentsDelta: number;
    }
  ): void {
    const key = this.buildMetricContextKey(context);
    const existing = deltasByContext.get(key);
    if (existing == null) {
      deltasByContext.set(key, { context, delta: { ...delta } });
      return;
    }

    existing.delta.revenueDelta += delta.revenueDelta;
    existing.delta.appointmentsDelta += delta.appointmentsDelta;
    existing.delta.completedAppointmentsDelta += delta.completedAppointmentsDelta;
    existing.delta.cancelledAppointmentsDelta += delta.cancelledAppointmentsDelta;
  }

  private buildMetricContextKey(context: AppointmentMetricContext): string {
    return [
      context.businessId.trim(),
      context.branchId.trim(),
      context.employeeId.trim(),
      context.date.trim(),
    ].join("|");
  }

  private async applyMetricDeltaIfNeeded(
    context: AppointmentMetricContext,
    delta: {
      revenueDelta: number;
      appointmentsDelta: number;
      completedAppointmentsDelta: number;
      cancelledAppointmentsDelta: number;
    }
  ): Promise<void> {
    if (
      delta.revenueDelta === 0 &&
      delta.appointmentsDelta === 0 &&
      delta.completedAppointmentsDelta === 0 &&
      delta.cancelledAppointmentsDelta === 0
    ) {
      return;
    }

    if (
      context.businessId.trim() === "" ||
      context.branchId.trim() === "" ||
      context.employeeId.trim() === "" ||
      context.date.trim() === ""
    ) {
      return;
    }

    await this.metricService.applyAppointmentMetricDelta({
      businessId: context.businessId,
      branchId: context.branchId,
      employeeId: context.employeeId,
      date: context.date,
      revenueDelta: delta.revenueDelta,
      appointmentsDelta: delta.appointmentsDelta,
      completedAppointmentsDelta: delta.completedAppointmentsDelta,
      cancelledAppointmentsDelta: delta.cancelledAppointmentsDelta,
    });
  }

  private resolveMetricContribution(
    status: AppointmentStatus,
    servicePrice: number
  ): {
    revenueDelta: number;
    appointmentsDelta: number;
    completedAppointmentsDelta: number;
    cancelledAppointmentsDelta: number;
  } {
    if (status === "DELETED") {
      return {
        revenueDelta: 0,
        appointmentsDelta: 0,
        completedAppointmentsDelta: 0,
        cancelledAppointmentsDelta: 0,
      };
    }

    const isRevenueStatus =
      status === "CREATED" || status === "IN_PROGRESS" || status === "FINISHED";

    return {
      revenueDelta: isRevenueStatus ? Math.max(0, servicePrice) : 0,
      appointmentsDelta: 1,
      completedAppointmentsDelta: status === "FINISHED" ? 1 : 0,
      cancelledAppointmentsDelta: status === "CANCELLED" ? 1 : 0,
    };
  }

  private negateContribution(contribution: {
    revenueDelta: number;
    appointmentsDelta: number;
    completedAppointmentsDelta: number;
    cancelledAppointmentsDelta: number;
  }): {
    revenueDelta: number;
    appointmentsDelta: number;
    completedAppointmentsDelta: number;
    cancelledAppointmentsDelta: number;
  } {
    return {
      revenueDelta: -contribution.revenueDelta,
      appointmentsDelta: -contribution.appointmentsDelta,
      completedAppointmentsDelta: -contribution.completedAppointmentsDelta,
      cancelledAppointmentsDelta: -contribution.cancelledAppointmentsDelta,
    };
  }

  private normalizeStoredDate(dateValue: Timestamp | string, fallback?: string): string {
    if (typeof dateValue === "string" && dateValue.trim() !== "") {
      return dateValue.trim();
    }

    if (dateValue instanceof Timestamp) {
      return dateValue.toDate().toISOString().slice(0, 10);
    }

    return fallback ?? "";
  }

  private async getServicePriceById(serviceId: string, businessId: string): Promise<number> {
    const normalizedServiceId = serviceId.trim();
    if (normalizedServiceId === "") return 0;

    const services = await FirestoreService.getAll<Service>(SERVICES_COLLECTION, [
      { field: "id", operator: "==", value: normalizedServiceId },
      { field: "businessId", operator: "==", value: businessId },
    ]);

    if (services.length === 0) {
      throw CustomError.notFound("No existe un servicio con este id");
    }

    return services[0]!.price ?? 0;
  }

  private async scheduleStatusTasksForCreatedAppointment(
    appointment: Appointment
  ): Promise<void> {
    if (this.appointmentStatusTaskScheduler == null) return;

    await this.appointmentStatusTaskScheduler.scheduleAppointmentStatusTasks({
      appointmentId: appointment.id,
      date: appointment.date,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
    });
  }

  private async rescheduleStatusTasksForAppointment(
    appointment: Appointment,
    reason: string
  ): Promise<void> {
    if (this.appointmentStatusTaskScheduler == null) return;

    try {
      await this.appointmentStatusTaskScheduler.deleteAppointmentStatusTasks({
        appointmentId: appointment.id,
      });
      await this.appointmentStatusTaskScheduler.scheduleAppointmentStatusTasks({
        appointmentId: appointment.id,
        date: appointment.date,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
      });
    } catch (taskError) {
      const detail =
        taskError instanceof Error
          ? taskError.message
          : typeof taskError === "string"
            ? taskError
            : JSON.stringify(taskError);

      logger.warn(
        `[AppointmentService] No se pudieron reprogramar tasks automáticas al ${reason} la cita ${appointment.id}. detalle=${detail}`
      );
    }
  }

  private async deleteStatusTasksForAppointment(
    appointmentId: string,
    reason: string
  ): Promise<void> {
    if (this.appointmentStatusTaskScheduler == null) return;

    try {
      await this.appointmentStatusTaskScheduler.deleteAppointmentStatusTasks({
        appointmentId,
      });
    } catch (taskError) {
      const detail =
        taskError instanceof Error
          ? taskError.message
          : typeof taskError === "string"
            ? taskError
            : JSON.stringify(taskError);

      logger.warn(
        `[AppointmentService] No se pudieron eliminar tasks automáticas al ${reason} la cita ${appointmentId}. detalle=${detail}`
      );
    }
  }

  private async getStoredAppointmentById(id: string): Promise<AppointmentStored> {
    const appointments = await FirestoreService.getAll<AppointmentStored>(
      COLLECTION_NAME,
      [{ field: "id", operator: "==", value: id }]
    );
    if (appointments.length === 0) {
      throw CustomError.notFound("No existe una cita con este id");
    }
    return appointments[0]!;
  }

  private async syncBookingStatusFromAppointments(bookingId: string): Promise<void> {
    try {
      const [booking, appointments] = await Promise.all([
        FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId),
        FirestoreService.getAll<AppointmentStored>(COLLECTION_NAME, [
          { field: "bookingId", operator: "==", value: bookingId },
        ]),
      ]);

      if (appointments.length === 0) return;

      const now = FirestoreDataBase.generateTimeStamp();
      const payload: Record<string, unknown> = {
        totalAmount: await this.calculateBookingTotalPrice(
          booking.businessId,
          appointments
        ),
        updatedAt: now,
      };

      const bookingStatus = this.resolveBookingStatusFromAppointments(appointments);
      if (bookingStatus != null) {
        payload.status = bookingStatus;
        if (bookingStatus === "CANCELLED") {
          if (booking.status !== "CANCELLED") {
            payload.cancelledAt = now;
          }
          payload.deletedAt = FieldValue.delete();
        } else if (bookingStatus === "DELETED") {
          if (booking.status !== "DELETED") {
            payload.deletedAt = now;
          }
          payload.cancelledAt = FieldValue.delete();
        } else {
          payload.cancelledAt = FieldValue.delete();
          payload.deletedAt = FieldValue.delete();
        }
      }

      await FirestoreService.update(BOOKINGS_COLLECTION, bookingId, payload);
    } catch (error) {
      if (error instanceof CustomError && error.statusCode === 404) return;
      throw error;
    }
  }

  private resolveBookingStatusFromAppointments(
    appointments: AppointmentStored[]
  ): BookingStatus | null {
    if (appointments.length === 0) return null;

    const statuses = appointments.map((appointment) => appointment.status);
    const firstStatus = statuses[0];
    if (
      firstStatus !== "CREATED" &&
      firstStatus !== "CANCELLED" &&
      firstStatus !== "FINISHED" &&
      firstStatus !== "DELETED"
    ) {
      return null;
    }

    const allSameStatus = statuses.every((status) => status === firstStatus);
    if (!allSameStatus) return null;

    return firstStatus;
  }

  private async calculateBookingTotalPrice(
    businessId: string,
    appointments: AppointmentStored[]
  ): Promise<number> {
    const activeServiceIds = appointments
      .filter(
        (appointment) =>
          appointment.status !== "CANCELLED" && appointment.status !== "DELETED"
      )
      .map((appointment) => this.resolveServiceAndRange(appointment).serviceId.trim())
      .filter((serviceId) => serviceId !== "");

    if (activeServiceIds.length === 0) return 0;

    const services = await FirestoreService.getAll<Service>(SERVICES_COLLECTION, [
      { field: "businessId", operator: "==", value: businessId },
    ]);
    const servicesById = new Map(
      services.map((service) => [service.id.trim(), service.price] as const)
    );

    return activeServiceIds.reduce((total, serviceId) => {
      return total + (servicesById.get(serviceId) ?? 0);
    }, 0);
  }

  async ensureBusinessAndBranch(
    businessId: string,
    branchId: string
  ): Promise<Branch> {
    await this.ensureBusinessExists(businessId);
    return this.ensureBranchBelongsToBusiness(branchId, businessId);
  }

  async ensureClientForBusiness(businessId: string, clientData: ClientData): Promise<void> {
    await this.ensureClientForAppointment(businessId, clientData);
  }

  public ensureAppointmentDateTimeIsNotPast(date: string, startTime: string): void {
    const dateMatch = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = startTime.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!dateMatch || !timeMatch) {
      throw CustomError.badRequest(
        "date y startTime deben tener formato válido (YYYY-MM-DD y HH:mm)"
      );
    }

    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);

    const appointmentDateTime = new Date(year, month - 1, day, hours, minutes, 0, 0);
    if (
      Number.isNaN(appointmentDateTime.getTime()) ||
      appointmentDateTime.getFullYear() !== year ||
      appointmentDateTime.getMonth() !== month - 1 ||
      appointmentDateTime.getDate() !== day
    ) {
      throw CustomError.badRequest(
        "date y startTime deben representar una fecha y hora válidas"
      );
    }

    if (appointmentDateTime.getTime() < Date.now()) {
      throw CustomError.badRequest(
        "La fecha y hora de la cita no pueden ser anteriores al momento actual"
      );
    }
  }

  private async ensureBusinessExists(businessId: string): Promise<void> {
    const cacheKey = `business:${businessId}`;
    if (this.validationCache.has(cacheKey)) return;

    const businesses = await FirestoreService.getAll<Business>(BUSINESS_COLLECTION, [
      { field: "id", operator: "==", value: businessId },
    ]);

    if (businesses.length === 0) {
      throw CustomError.notFound("No existe un negocio con este id");
    }

    if (businesses[0]!.status === "DELETED") {
      throw CustomError.badRequest(
        "No se pueden crear citas para un negocio eliminado"
      );
    }

    this.validationCache.set(cacheKey, true);
  }

  private async ensureBranchBelongsToBusiness(
    branchId: string,
    businessId: string
  ): Promise<Branch> {
    const cacheKey = `branch:${branchId}:${businessId}`;
    const cachedBranch = this.validationCache.get(cacheKey) as Branch | undefined;
    if (cachedBranch) return cachedBranch;

    const branches = await FirestoreService.getAll<Branch>(BRANCH_COLLECTION, [
      { field: "id", operator: "==", value: branchId },
    ]);

    if (branches.length === 0) {
      throw CustomError.notFound("No existe una sede con este id");
    }

    const branch = branches[0]!;
    if (branch.status === "DELETED") {
      throw CustomError.badRequest(
        "No se pueden crear citas para una sede eliminada"
      );
    }

    if (branch.businessId !== businessId) {
      throw CustomError.badRequest(
        "La sede indicada no pertenece al negocio enviado"
      );
    }

    this.validationCache.set(cacheKey, branch);
    return branch;
  }

  private async ensureServiceExistsInBusiness(
    serviceId: string,
    businessId: string
  ): Promise<Service> {
    const services = await FirestoreService.getAll<Service>(SERVICES_COLLECTION, [
      { field: "id", operator: "==", value: serviceId },
    ]);

    if (services.length === 0) {
      throw CustomError.notFound("No existe un servicio con este id");
    }

    const service = services[0]!;
    if (service.businessId !== businessId || service.status === "DELETED") {
      throw CustomError.badRequest(
        "serviceId debe pertenecer a un servicio vigente del negocio"
      );
    }

    return service;
  }

  private async ensureEmployeeIsActiveInBusiness(
    employeeId: string,
    businessId: string
  ): Promise<void> {
    const [memberships, usersById, usersByDocument] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(BUSINESS_MEMBERSHIPS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<User>(USERS_COLLECTION, [
        { field: "id", operator: "==", value: employeeId },
      ]),
      FirestoreService.getAll<User>(USERS_COLLECTION, [
        { field: "document", operator: "==", value: employeeId },
      ]),
    ]);

    const allowedUserIds = new Set<string>([employeeId]);
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

    const isValidEmployee = memberships.some(
      (membership) =>
        allowedUserIds.has(membership.userId) &&
        membership.status === "ACTIVE" &&
        membership.isEmployee === true
    );

    if (!isValidEmployee) {
      throw CustomError.badRequest(
        "employeeId debe pertenecer a una membresía ACTIVE con isEmployee=true en este negocio"
      );
    }
  }

  private async ensureNoEmployeeScheduleConflict(
    employeeId: string,
    date: string,
    startTime: string,
    endTime: string,
    excludedAppointmentId?: string
  ): Promise<void> {
    const appointments = await FirestoreService.getAll<AppointmentStored>(
      COLLECTION_NAME,
      [
        { field: "employeeId", operator: "==", value: employeeId },
        { field: "date", operator: "==", value: date },
        {
          field: "status",
          operator: "in",
          value: ["CREATED", "IN_PROGRESS", "FINISHED"],
        },
      ]
    );

    const targetStart = this.timeToMinutes(startTime);
    const targetEnd = this.timeToMinutes(endTime);

    const hasConflict = appointments.some((appointment) => {
      if (excludedAppointmentId != null && appointment.id === excludedAppointmentId) {
        return false;
      }

      const existingRanges = this.resolveAppointmentRanges(appointment);
      return existingRanges.some(
        (existing) => targetStart < existing.end && existing.start < targetEnd
      );
    });

    if (hasConflict) {
      throw CustomError.badRequest(
        "El empleado ya tiene una cita en ese día y horario"
      );
    }
  }

  private resolveAppointmentRanges(
    appointment: AppointmentStored
  ): Array<{ start: number; end: number }> {
    if (
      typeof appointment.startTime === "string" &&
      appointment.startTime.trim() !== "" &&
      typeof appointment.endTime === "string" &&
      appointment.endTime.trim() !== ""
    ) {
      return [
        {
          start: this.timeToMinutes(appointment.startTime),
          end: this.timeToMinutes(appointment.endTime),
        },
      ];
    }

    const legacyServices = appointment.services ?? [];
    return legacyServices
      .filter(
        (service) =>
          typeof service.startTime === "string" &&
          service.startTime.trim() !== "" &&
          typeof service.endTime === "string" &&
          service.endTime.trim() !== ""
      )
      .map((service) => ({
        start: this.timeToMinutes(service.startTime),
        end: this.timeToMinutes(service.endTime),
      }));
  }

  private timeToMinutes(value: string): number {
    const trimmedValue = value.trim();
    const hhmmMatch = trimmedValue.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (hhmmMatch) {
      return Number(hhmmMatch[1]) * 60 + Number(hhmmMatch[2]);
    }

    const millis = Date.parse(trimmedValue);
    if (Number.isNaN(millis)) {
      throw CustomError.badRequest(`Hora inválida: ${value}`);
    }
    const parsedDate = new Date(millis);
    return parsedDate.getUTCHours() * 60 + parsedDate.getUTCMinutes();
  }

  private ensureTimeRangeWithinBranchSchedule(
    branch: Branch,
    date: string,
    startTime: string,
    endTime: string
  ): void {
    const start = this.timeToMinutes(startTime);
    const end = this.timeToMinutes(endTime);
    if (end <= start) {
      throw CustomError.badRequest("endTime debe ser mayor que startTime");
    }

    const dayOfWeek = this.resolveDayOfWeek(date);
    const daySchedule = branch.schedule.find((day) => day.day === dayOfWeek);

    if (daySchedule == null || !daySchedule.isOpen) {
      throw CustomError.badRequest("La sede no está disponible en el día seleccionado");
    }

    const isWithinAnySlot = daySchedule.slots.some((slot) => {
      const opening = this.timeToMinutes(slot.openingTime);
      const closing = this.timeToMinutes(slot.closingTime);
      return start >= opening && end <= closing;
    });

    if (!isWithinAnySlot) {
      throw CustomError.badRequest(
        "La cita debe estar dentro del horario configurado para ese día en la sede"
      );
    }
  }

  private resolveDayOfWeek(date: string): number {
    const match = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      throw CustomError.badRequest("date debe tener formato YYYY-MM-DD");
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    const parsed = new Date(year, month - 1, day);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day
    ) {
      throw CustomError.badRequest("date no es una fecha válida");
    }

    return parsed.getDay();
  }

  private async ensureClientForAppointment(
    businessId: string,
    clientData: ClientData
  ): Promise<void> {
    const clientDocument = clientData.document.trim();
    if (clientDocument === "") {
      throw CustomError.badRequest("clientId es requerido");
    }

    const existingUsers = await FirestoreService.getAll<User>(USERS_COLLECTION, [
      { field: "document", operator: "==", value: clientDocument },
    ]);
    if (existingUsers.length > 0) {
      return;
    }

    if (
      clientData.name == null ||
      clientData.name.trim() === "" ||
      clientData.phone == null ||
      clientData.phone.trim() === "" ||
      clientData.documentTypeId == null ||
      clientData.documentTypeId.trim() === "" ||
      clientData.documentTypeName == null ||
      clientData.documentTypeName.trim() === ""
    ) {
      throw CustomError.badRequest(
        "Si el cliente no existe, debes enviar clientName, clientPhone, clientDocumentTypeId y clientDocumentTypeName para crearlo"
      );
    }

    const createdUser = await FirestoreService.create<{
      phone: string;
      name: string;
      email: string;
      isAuthActive: boolean;
      document: string;
      documentTypeName: string;
      documentTypeId: string;
      profilePhotoUrl: string;
      createdAt: ReturnType<typeof FirestoreDataBase.generateTimeStamp>;
    }>(USERS_COLLECTION, {
      phone: ensureColombiaCountryCode(clientData.phone.trim()),
      name: clientData.name.trim(),
      email: clientData.email?.trim() ?? "",
      isAuthActive: false,
      document: clientDocument,
      documentTypeName: clientData.documentTypeName!.trim(),
      documentTypeId: clientData.documentTypeId!.trim(),
      profilePhotoUrl: "",
      createdAt: FirestoreDataBase.generateTimeStamp(),
    });

    const createdMembership = await FirestoreService.create<{
      businessId: string;
      userId: string;
      isEmployee: boolean;
      roleId: string;
      status: "PENDING";
      createdAt: ReturnType<typeof FirestoreDataBase.generateTimeStamp>;
    }>(BUSINESS_MEMBERSHIPS_COLLECTION, {
      businessId,
      userId: clientDocument,
      isEmployee: false,
      roleId: ROOT_CLIENT_ID,
      status: "PENDING",
      createdAt: FirestoreDataBase.generateTimeStamp(),
    });

    const membershipLinkId = FirestoreDataBase.getDB()
      .collection(USERS_COLLECTION)
      .doc(createdUser.id)
      .collection("businessMemberships")
      .doc().id;

    await FirestoreService.createInSubcollection(
      USERS_COLLECTION,
      createdUser.id,
      "businessMemberships",
      {
        id: membershipLinkId,
        membershipId: createdMembership.id,
      }
    );
  }

  private resolveServiceAndRange(appointment: AppointmentStored): {
    serviceId: string;
    startTime: string;
    endTime: string;
  } {
    const serviceId = appointment.serviceId?.trim() ?? "";
    const startTime = appointment.startTime?.trim() ?? "";
    const endTime = appointment.endTime?.trim() ?? "";

    if (serviceId !== "" && startTime !== "" && endTime !== "") {
      return { serviceId, startTime, endTime };
    }

    const firstLegacyService = appointment.services?.[0];
    if (
      firstLegacyService &&
      firstLegacyService.id.trim() !== "" &&
      firstLegacyService.startTime.trim() !== "" &&
      firstLegacyService.endTime.trim() !== ""
    ) {
      return {
        serviceId: firstLegacyService.id.trim(),
        startTime: firstLegacyService.startTime.trim(),
        endTime: firstLegacyService.endTime.trim(),
      };
    }

    return {
      serviceId,
      startTime,
      endTime,
    };
  }

  private mapAppointmentToResponse(appointment: AppointmentStored): Appointment {
    const serviceAndRange = this.resolveServiceAndRange(appointment);

    return {
      id: appointment.id,
      businessId: appointment.businessId?.trim() ?? "",
      date:
        appointment.date instanceof Timestamp
          ? appointment.date.toDate().toISOString().split("T")[0]!
          : appointment.date,
      startTime: serviceAndRange.startTime,
      endTime: serviceAndRange.endTime,
      serviceId: serviceAndRange.serviceId,
      employeeId: appointment.employeeId?.trim() ?? "",
      status: appointment.status,
      bookingId: appointment.bookingId?.trim() ?? "",
      createdAt: appointment.createdAt,
      ...(appointment.cancelledAt !== undefined && {
        cancelledAt: appointment.cancelledAt,
      }),
      ...(appointment.deletedAt !== undefined && {
        deletedAt: appointment.deletedAt,
      }),
      ...(appointment.updatedAt !== undefined && {
        updatedAt: appointment.updatedAt,
      }),
    };
  }

  private resolveBookingPaymentStatus(
    totalAmount: number,
    paidAmount: number
  ): "PENDING" | "PARTIALLY_PAID" | "PAID" {
    if (totalAmount <= 0 || paidAmount <= 0) {
      return "PENDING";
    }
    if (paidAmount >= totalAmount) {
      return "PAID";
    }
    return "PARTIALLY_PAID";
  }
}
