import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import type {
  Appointment,
  AppointmentStatus,
} from "../../domain/interfaces/appointment.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from "../../domain/interfaces/booking.interface";
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
import { BusinessUsageLimitService } from "./business-usage-limit.service";
import { MetricService } from "./metric.service";
import { BookingConsecutiveService } from "./booking-consecutive.service";
import type { WhatsAppService } from "./whatsapp.service";
import { UserService } from "./user.service";
import type { PushNotificationService } from "./push-notification.service";

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
  paymentStatus: BookingPaymentStatus;
}

export interface BookingRevenueSnapshot {
  bookingId: string;
  businessId: string;
  branchId: string;
  paidAmount: number;
  appointments: Array<{
    id: string;
    date: string;
    startTime: string;
    serviceId: string;
    employeeId: string;
    status: AppointmentStatus;
  }>;
}

interface RevenueMetricContext {
  businessId: string;
  branchId: string;
  employeeId: string;
  date: string;
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
  skipBookingSync?: boolean;
}

export interface SetAppointmentStatusOptions {
  skipBookingSync?: boolean;
}

export class AppointmentService {
  private validationCache = new Map<string, unknown>();

  constructor(
    private readonly reviewService: ReviewService = new ReviewService(),
    private readonly appointmentStatusTaskScheduler?: AppointmentStatusTaskScheduler,
    private readonly metricService: MetricService = new MetricService(),
    private readonly bookingConsecutiveService: BookingConsecutiveService =
      new BookingConsecutiveService(),
    private readonly whatsAppService?: WhatsAppService,
    private readonly pushNotificationService?: PushNotificationService,
    private readonly userService: UserService = new UserService(),
    private readonly businessUsageLimitService: BusinessUsageLimitService =
      new BusinessUsageLimitService()
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
    let bookingQuotaConsumed = false;

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
        const beforeRevenueSnapshot = await this.captureBookingRevenueSnapshot(
          booking.id
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
        const nextPaymentStatus = this.resolveBookingPaymentStatus(
          nextTotalAmount,
          currentPaidAmount
        );

        await FirestoreService.update(BOOKINGS_COLLECTION, booking.id, {
          appointments: nextAppointments,
          totalAmount: nextTotalAmount,
          paymentStatus: nextPaymentStatus,
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        });

        await this.syncBookingRevenueMetricsFromSnapshot(
          booking.id,
          beforeRevenueSnapshot
        );

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
      await this.businessUsageLimitService.consume(dto.businessId, "bookings", 1);
      bookingQuotaConsumed = true;
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

      await this.syncBookingRevenueMetricsFromSnapshot(createdBooking.id, null);

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

      await this.sendBookingCreatedWhatsApp(
        createdBooking.id,
        dto.businessId,
        consecutive,
        dto.clientId
      ).catch((whatsAppError) => {
        const detail =
          whatsAppError instanceof Error
            ? whatsAppError.message
            : typeof whatsAppError === "string"
              ? whatsAppError
              : JSON.stringify(whatsAppError);

        logger.warn(
          `[AppointmentService] No se pudo enviar WhatsApp de confirmación para booking ${createdBooking.id}. detalle=${detail}`
        );
      });

      await this.pushNotificationService
        ?.notifyBookingCreated({
          businessId: dto.businessId,
          branchId: dto.branchId,
          bookingId: createdBooking.id,
          bookingConsecutive: consecutive,
          clientDocument: dto.clientId,
          employeeIds: [createdAppointment.employeeId],
          appointments: [
            {
              date: createdAppointment.date,
              startTime: createdAppointment.startTime,
            },
          ],
        })
        .catch((pushNotificationError) => {
          const detail =
            pushNotificationError instanceof Error
              ? pushNotificationError.message
              : typeof pushNotificationError === "string"
                ? pushNotificationError
                : JSON.stringify(pushNotificationError);

          logger.warn(
            `[AppointmentService] No se pudo enviar notificación push para booking ${createdBooking.id}. detalle=${detail}`
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

      if (bookingQuotaConsumed) {
        await this.businessUsageLimitService.release(dto.businessId, "bookings", 1).catch(
          () => undefined
        );
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
      const bookingPaymentStatus = this.resolveBookingPaymentStatusFromBooking(booking);
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
        paymentStatus: bookingPaymentStatus,
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
      const existingAppointment = await this.getStoredAppointmentById(id);
      if (dto.status === "CANCELLED") {
        return await this.cancelAppointment(id);
      }
      if (dto.status === "FINISHED") {
        return await this.setAppointmentStatus(id, "FINISHED");
      }

      const isRestoringCancelledAppointment =
        dto.status === "CREATED" && existingAppointment.status === "CANCELLED";
      this.ensureAppointmentDateTimeIsNotPast(dto.date, dto.startTime);

      if (
        !isRestoringCancelledAppointment &&
        (existingAppointment.status === "IN_PROGRESS" ||
          existingAppointment.status === "DELETED" ||
          existingAppointment.status === "CANCELLED" ||
          existingAppointment.status === "FINISHED")
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
      const bookingPaymentStatus = this.resolveBookingPaymentStatusFromBooking(booking);
      const beforeRevenueSnapshot =
        opts?.skipBookingSync === true
          ? null
          : await this.captureBookingRevenueSnapshot(booking.id);
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
      const currentStatus = existingAppointment.status;

      const beforeMetricContext = {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: existingAppointment.employeeId ?? dto.employeeId,
        date: this.normalizeStoredDate(existingAppointment.date, dto.date),
        status: currentStatus,
        servicePrice: previousServicePrice,
        paymentStatus: bookingPaymentStatus,
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
      if (opts?.skipBookingSync !== true) {
        await this.syncBookingStatusFromAppointments(booking.id);
        await this.syncBookingRevenueMetricsFromSnapshot(
          booking.id,
          beforeRevenueSnapshot
        );
      }

      await this.applyAppointmentMetricTransition(beforeMetricContext, {
        businessId: booking.businessId,
        branchId: branchIdForValidation,
        employeeId: dto.employeeId,
        date: dto.date,
        status: "CREATED",
        servicePrice: nextService.price,
        paymentStatus: bookingPaymentStatus,
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

  async setAppointmentStatus(
    id: string,
    status: Exclude<AppointmentStatus, "IN_PROGRESS">,
    opts?: SetAppointmentStatusOptions
  ): Promise<Appointment> {
    if (status === "CREATED") {
      return this.restoreAppointmentToCreated(id, opts);
    }
    if (status === "CANCELLED") {
      return this.cancelAppointment(id, opts);
    }
    if (status === "DELETED") {
      return this.deleteAppointment(id, opts);
    }
    return this.finishAppointment(id, opts);
  }

  async cancelAppointment(
    id: string,
    opts?: SetAppointmentStatusOptions
  ): Promise<Appointment> {
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
      const bookingPaymentStatus = this.resolveBookingPaymentStatusFromBooking(booking);
      const beforeRevenueSnapshot =
        opts?.skipBookingSync === true
          ? null
          : await this.captureBookingRevenueSnapshot(booking.id);
      const beforeServicePrice = await this.getServicePriceById(
        existingAppointment.serviceId ?? "",
        booking.businessId
      );

      await FirestoreService.update(COLLECTION_NAME, id, {
        status: "CANCELLED",
        cancelledAt: FirestoreDataBase.generateTimeStamp(),
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      if (opts?.skipBookingSync !== true) {
        await this.syncBookingStatusFromAppointments(bookingId);
        await this.syncBookingRevenueMetricsFromSnapshot(
          booking.id,
          beforeRevenueSnapshot
        );
      }

      await this.applyAppointmentMetricTransition(
        {
          businessId: booking.businessId,
          branchId: booking.branchId,
          employeeId: existingAppointment.employeeId ?? "",
          date: this.normalizeStoredDate(existingAppointment.date),
          status: existingAppointment.status,
          servicePrice: beforeServicePrice,
          paymentStatus: bookingPaymentStatus,
        },
        {
          businessId: booking.businessId,
          branchId: booking.branchId,
          employeeId: existingAppointment.employeeId ?? "",
          date: this.normalizeStoredDate(existingAppointment.date),
          status: "CANCELLED",
          servicePrice: beforeServicePrice,
          paymentStatus: bookingPaymentStatus,
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

  async deleteAppointment(
    id: string,
    opts?: SetAppointmentStatusOptions
  ): Promise<Appointment> {
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
      const bookingPaymentStatus = this.resolveBookingPaymentStatusFromBooking(booking);
      const beforeRevenueSnapshot =
        opts?.skipBookingSync === true
          ? null
          : await this.captureBookingRevenueSnapshot(booking.id);
      const beforeServicePrice = await this.getServicePriceById(
        existingAppointment.serviceId ?? "",
        booking.businessId
      );

      await this.reviewService.deleteReviewsByAppointmentId(id);

      await FirestoreService.update(COLLECTION_NAME, id, {
        status: "DELETED",
        deletedAt: FirestoreDataBase.generateTimeStamp(),
      });

      if (opts?.skipBookingSync !== true) {
        const syncResult = await this.syncBookingStatusFromAppointments(bookingId);
        if (
          syncResult.nextStatus === "DELETED" &&
          syncResult.previousStatus !== "DELETED"
        ) {
          await this.businessUsageLimitService.release(
            booking.businessId,
            "bookings",
            1
          );
        }
        await this.syncBookingRevenueMetricsFromSnapshot(
          booking.id,
          beforeRevenueSnapshot
        );
      }

      await this.applyAppointmentMetricTransition(
        {
          businessId: booking.businessId,
          branchId: booking.branchId,
          employeeId: existingAppointment.employeeId ?? "",
          date: this.normalizeStoredDate(existingAppointment.date),
          status: existingAppointment.status,
          servicePrice: beforeServicePrice,
          paymentStatus: bookingPaymentStatus,
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
    return {
      appointment: await this.finishAppointment(id),
      changed: true,
    };
  }

  async captureBookingRevenueSnapshot(
    bookingId: string
  ): Promise<BookingRevenueSnapshot | null> {
    try {
      const [booking, appointments] = await Promise.all([
        FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId),
        FirestoreService.getAll<AppointmentStored>(COLLECTION_NAME, [
          { field: "bookingId", operator: "==", value: bookingId },
        ]),
      ]);

      return {
        bookingId: booking.id,
        businessId: booking.businessId,
        branchId: booking.branchId,
        paidAmount:
          Number.isFinite(booking.paidAmount) && booking.paidAmount >= 0
            ? booking.paidAmount
            : 0,
        appointments: appointments.map((appointment) => {
          const mappedAppointment = this.mapAppointmentToResponse(appointment);
          return {
            id: mappedAppointment.id,
            date: mappedAppointment.date,
            startTime: mappedAppointment.startTime,
            serviceId: mappedAppointment.serviceId,
            employeeId: mappedAppointment.employeeId,
            status: mappedAppointment.status,
          };
        }),
      };
    } catch (error) {
      if (error instanceof CustomError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async syncBookingRevenueMetricsFromSnapshot(
    bookingId: string,
    beforeSnapshot: BookingRevenueSnapshot | null
  ): Promise<void> {
    const afterSnapshot = await this.captureBookingRevenueSnapshot(bookingId);

    const [beforeContributions, afterContributions] = await Promise.all([
      this.buildRevenueContributionsByAppointment(beforeSnapshot),
      this.buildRevenueContributionsByAppointment(afterSnapshot),
    ]);

    const deltasByContext = new Map<
      string,
      { context: RevenueMetricContext; revenueDelta: number }
    >();

    const appointmentIds = new Set<string>([
      ...beforeContributions.keys(),
      ...afterContributions.keys(),
    ]);

    for (const appointmentId of appointmentIds) {
      const beforeContribution = beforeContributions.get(appointmentId);
      const afterContribution = afterContributions.get(appointmentId);

      if (beforeContribution != null) {
        this.accumulateRevenueMetricDelta(
          deltasByContext,
          beforeContribution.context,
          -beforeContribution.revenue
        );
      }

      if (afterContribution != null) {
        this.accumulateRevenueMetricDelta(
          deltasByContext,
          afterContribution.context,
          afterContribution.revenue
        );
      }
    }

    for (const { context, revenueDelta } of deltasByContext.values()) {
      const normalizedDelta = this.roundMoney(revenueDelta);
      if (normalizedDelta === 0) continue;

      await this.metricService.applyAppointmentMetricDelta({
        businessId: context.businessId,
        branchId: context.branchId,
        employeeId: context.employeeId,
        date: context.date,
        revenueDelta: normalizedDelta,
      });
    }
  }

  private async buildRevenueContributionsByAppointment(
    snapshot: BookingRevenueSnapshot | null
  ): Promise<Map<string, { context: RevenueMetricContext; revenue: number }>> {
    const contributions = new Map<
      string,
      { context: RevenueMetricContext; revenue: number }
    >();

    if (snapshot == null || snapshot.paidAmount <= 0 || snapshot.appointments.length === 0) {
      return contributions;
    }

    const services = await FirestoreService.getAll<Service>(SERVICES_COLLECTION, [
      { field: "businessId", operator: "==", value: snapshot.businessId },
    ]);
    const servicePricesById = new Map(
      services.map((service) => [service.id.trim(), Math.max(0, service.price ?? 0)] as const)
    );

    const activeAppointments = snapshot.appointments
      .filter((appointment) => this.isRevenueBookingStatus(appointment.status))
      .map((appointment) => ({
        appointment,
        price: servicePricesById.get(appointment.serviceId.trim()) ?? 0,
      }))
      .filter(({ price }) => price > 0)
      .sort((a, b) => {
        if (a.appointment.date !== b.appointment.date) {
          return a.appointment.date.localeCompare(b.appointment.date);
        }
        if (a.appointment.startTime !== b.appointment.startTime) {
          return a.appointment.startTime.localeCompare(b.appointment.startTime);
        }
        return a.appointment.id.localeCompare(b.appointment.id);
      });

    if (activeAppointments.length === 0) {
      return contributions;
    }

    const totalActiveAmount = activeAppointments.reduce(
      (sum, item) => sum + item.price,
      0
    );
    if (totalActiveAmount <= 0) {
      return contributions;
    }

    const totalPaidToDistribute = this.roundMoney(
      Math.min(snapshot.paidAmount, totalActiveAmount)
    );
    if (totalPaidToDistribute <= 0) {
      return contributions;
    }

    let distributedAmount = 0;
    activeAppointments.forEach((item, index) => {
      const isLast = index === activeAppointments.length - 1;
      const revenue = isLast
        ? this.roundMoney(totalPaidToDistribute - distributedAmount)
        : this.roundMoney((totalPaidToDistribute * item.price) / totalActiveAmount);
      const normalizedRevenue = Math.max(0, revenue);
      distributedAmount = this.roundMoney(distributedAmount + normalizedRevenue);

      if (normalizedRevenue === 0) return;

      contributions.set(item.appointment.id, {
        context: {
          businessId: snapshot.businessId,
          branchId: snapshot.branchId,
          employeeId: item.appointment.employeeId,
          date: item.appointment.date,
        },
        revenue: normalizedRevenue,
      });
    });

    return contributions;
  }

  private accumulateRevenueMetricDelta(
    deltasByContext: Map<
      string,
      { context: RevenueMetricContext; revenueDelta: number }
    >,
    context: RevenueMetricContext,
    revenueDelta: number
  ): void {
    const key = [
      context.businessId.trim(),
      context.branchId.trim(),
      context.employeeId.trim(),
      context.date.trim(),
    ].join("|");

    const existing = deltasByContext.get(key);
    if (existing == null) {
      deltasByContext.set(key, {
        context,
        revenueDelta,
      });
      return;
    }

    existing.revenueDelta += revenueDelta;
  }

  private async applyAppointmentMetricTransition(
    before: AppointmentMetricContext | null,
    after: AppointmentMetricContext | null
  ): Promise<void> {
    const beforeContribution =
      before == null
        ? null
        : this.resolveMetricContribution(
            before.status,
            before.servicePrice,
            before.paymentStatus
          );
    const afterContribution =
      after == null
        ? null
        : this.resolveMetricContribution(
            after.status,
            after.servicePrice,
            after.paymentStatus
          );

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
    servicePrice: number,
    paymentStatus: BookingPaymentStatus
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

    return {
      revenueDelta: 0,
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

  private async sendBookingCreatedWhatsApp(
    bookingId: string,
    businessId: string,
    bookingConsecutive: string,
    clientDocument: string,
    opts?: { cachedBusiness?: Business }
  ): Promise<void> {
    if (this.whatsAppService == null) return;

    const sanitizedDocument = clientDocument.trim();
    if (sanitizedDocument === "") return;

    const [user, business] = await Promise.all([
      this.userService.getByDocument(sanitizedDocument),
      opts?.cachedBusiness
        ? Promise.resolve(opts.cachedBusiness)
        : FirestoreService.getById<Business>(BUSINESS_COLLECTION, businessId),
    ]);
    const phone = user?.phone?.trim() ?? "";
    if (phone === "") return;
    const businessName = business.name?.trim() || "Cutlyy";
    const clientName = user?.name?.trim() || "cliente";

    const sendResult = await this.whatsAppService.sendTemplateMessage({
      to: phone,
      templateType: "APPOINTMENT_CONFIRMATION",
      headerPlaceholders: [businessName],
      bodyPlaceholders: [clientName, bookingConsecutive],
      buttons: [
        {
          type: "URL",
          parameter: bookingId,
        },
      ],
    });

    logger.info(
      `[AppointmentService] WhatsApp de confirmacion aceptado por Infobip. bookingId=${bookingId}, to=${phone}, templateType=APPOINTMENT_CONFIRMATION, messageId=${sendResult.messageId}`
    );
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

  private async syncBookingStatusFromAppointments(bookingId: string): Promise<{
    previousStatus: BookingStatus;
    nextStatus: BookingStatus;
  }> {
    try {
      const [booking, appointments] = await Promise.all([
        FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId),
        FirestoreService.getAll<AppointmentStored>(COLLECTION_NAME, [
          { field: "bookingId", operator: "==", value: bookingId },
        ]),
      ]);

      if (appointments.length === 0) {
        return {
          previousStatus: booking.status,
          nextStatus: booking.status,
        };
      }

      const now = FirestoreDataBase.generateTimeStamp();
      const nextTotalAmount = await this.calculateBookingTotalPrice(
        booking.businessId,
        appointments
      );
      const payload: Record<string, unknown> = {
        totalAmount: nextTotalAmount,
        paymentStatus: this.resolveBookingPaymentStatus(
          nextTotalAmount,
          Number.isFinite(booking.paidAmount) && booking.paidAmount >= 0
            ? booking.paidAmount
            : 0
        ),
        updatedAt: now,
      };

      const bookingStatus = this.resolveBookingStatusFromAppointments(appointments);
      let nextStatus = booking.status;
      if (bookingStatus != null) {
        nextStatus = bookingStatus;
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
      return {
        previousStatus: booking.status,
        nextStatus,
      };
    } catch (error) {
      if (error instanceof CustomError && error.statusCode === 404) {
        return {
          previousStatus: "DELETED",
          nextStatus: "DELETED",
        };
      }
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

  async ensureServiceExistsInBusiness(
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

  async ensureEmployeeIsActiveInBusiness(
    employeeId: string,
    businessId: string
  ): Promise<void> {
    const isValidEmployee = await this.isEmployeeActiveInBusiness(
      employeeId,
      businessId
    );

    if (!isValidEmployee) {
      throw CustomError.badRequest(
        "employeeId debe pertenecer a una membresía ACTIVE con isEmployee=true en este negocio"
      );
    }
  }

  private async isEmployeeActiveInBusiness(
    employeeId: string,
    businessId: string
  ): Promise<boolean> {
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
    return isValidEmployee;
  }

  private async restoreAppointmentToCreated(
    id: string,
    opts?: SetAppointmentStatusOptions
  ): Promise<Appointment> {
    const existingAppointment = await this.getStoredAppointmentById(id);
    if (existingAppointment.status === "DELETED") {
      throw CustomError.badRequest("No se puede cambiar el estado de una cita eliminada");
    }
    if (existingAppointment.status === "FINISHED") {
      throw CustomError.badRequest(
        "No se puede cambiar el estado de una cita finalizada"
      );
    }
    if (existingAppointment.status === "IN_PROGRESS") {
      throw CustomError.badRequest(
        "No se puede cambiar el estado de una cita en curso"
      );
    }

    const bookingId = existingAppointment.bookingId?.trim() ?? "";
    if (bookingId === "") {
      throw CustomError.badRequest("La cita no está vinculada a un booking");
    }

    const booking = await FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId);
    const bookingPaymentStatus = this.resolveBookingPaymentStatusFromBooking(booking);
    const beforeRevenueSnapshot =
      opts?.skipBookingSync === true
        ? null
        : await this.captureBookingRevenueSnapshot(booking.id);
    if (booking.status === "DELETED") {
      throw CustomError.badRequest("No se puede editar una cita de un booking eliminado");
    }

    const mapped = this.mapAppointmentToResponse(existingAppointment);
    await this.ensureBusinessAndBranch(booking.businessId, booking.branchId);
    const service = await this.ensureServiceExistsInBusiness(
      mapped.serviceId,
      booking.businessId
    );
    await this.ensureEmployeeIsActiveInBusiness(mapped.employeeId, booking.businessId);

    if (existingAppointment.status === "CREATED") {
      return mapped;
    }

    await FirestoreService.update(COLLECTION_NAME, id, {
      status: "CREATED",
      updatedAt: FirestoreDataBase.generateTimeStamp(),
      cancelledAt: FieldValue.delete(),
      deletedAt: FieldValue.delete(),
    });

    if (opts?.skipBookingSync !== true) {
      await this.syncBookingStatusFromAppointments(bookingId);
      await this.syncBookingRevenueMetricsFromSnapshot(
        booking.id,
        beforeRevenueSnapshot
      );
    }

    await this.applyAppointmentMetricTransition(
      {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: mapped.employeeId,
        date: mapped.date,
        status: existingAppointment.status,
        servicePrice: service.price,
        paymentStatus: bookingPaymentStatus,
      },
      {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: mapped.employeeId,
        date: mapped.date,
        status: "CREATED",
        servicePrice: service.price,
        paymentStatus: bookingPaymentStatus,
      }
    );

    const restored = await this.getStoredAppointmentById(id);
    const mappedRestored = this.mapAppointmentToResponse(restored);
    await this.rescheduleStatusTasksForAppointment(
      mappedRestored,
      "marcar en CREATED"
    );
    return mappedRestored;
  }

  private async finishAppointment(
    id: string,
    opts?: SetAppointmentStatusOptions
  ): Promise<Appointment> {
    const existingAppointment = await this.getStoredAppointmentById(id);
    if (existingAppointment.status === "DELETED") {
      throw CustomError.badRequest("No se puede finalizar una cita eliminada");
    }
    if (existingAppointment.status === "FINISHED") {
      return this.mapAppointmentToResponse(existingAppointment);
    }

    const mapped = this.mapAppointmentToResponse(existingAppointment);
    const bookingId = mapped.bookingId.trim();
    if (bookingId === "") {
      throw CustomError.badRequest("La cita no está vinculada a un booking");
    }

    const booking = await FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, bookingId);
    const bookingPaymentStatus = this.resolveBookingPaymentStatusFromBooking(booking);
    const servicePrice = await this.getServicePriceById(
      mapped.serviceId,
      booking.businessId
    ).catch((error) => {
      if (error instanceof CustomError && error.statusCode === 404) {
        return 0;
      }
      throw error;
    });
    const includeFinishedMetrics = await this.shouldCountAppointmentInMetrics({
      businessId: booking.businessId,
      branchId: booking.branchId,
      serviceId: mapped.serviceId,
      employeeId: mapped.employeeId,
    });

    await FirestoreService.update(COLLECTION_NAME, mapped.id, {
      status: "FINISHED",
      updatedAt: FirestoreDataBase.generateTimeStamp(),
      cancelledAt: FieldValue.delete(),
      deletedAt: FieldValue.delete(),
    });

    if (opts?.skipBookingSync !== true) {
      await this.syncBookingStatusFromAppointments(bookingId);
    }

    await this.applyAppointmentMetricTransition(
      {
        businessId: booking.businessId,
        branchId: booking.branchId,
        employeeId: mapped.employeeId,
        date: mapped.date,
        status: existingAppointment.status,
        servicePrice,
        paymentStatus: bookingPaymentStatus,
      },
      includeFinishedMetrics
        ? {
            businessId: booking.businessId,
            branchId: booking.branchId,
            employeeId: mapped.employeeId,
            date: mapped.date,
            status: "FINISHED",
            servicePrice,
            paymentStatus: bookingPaymentStatus,
          }
        : null
    );

    await this.deleteStatusTasksForAppointment(id, "marcar en FINISHED");

    const updated = await this.getStoredAppointmentById(mapped.id);
    return this.mapAppointmentToResponse(updated);
  }

  private async shouldCountAppointmentInMetrics(input: {
    businessId: string;
    branchId: string;
    serviceId: string;
    employeeId: string;
  }): Promise<boolean> {
    const [branchIsActive, serviceIsActive, employeeIsActive] = await Promise.all([
      this.isBranchActiveInBusiness(input.branchId, input.businessId),
      this.isServiceActiveInBusiness(input.serviceId, input.businessId),
      this.isEmployeeActiveInBusiness(input.employeeId, input.businessId),
    ]);

    return branchIsActive && serviceIsActive && employeeIsActive;
  }

  private async isBranchActiveInBusiness(
    branchId: string,
    businessId: string
  ): Promise<boolean> {
    const normalizedBranchId = branchId.trim();
    if (normalizedBranchId === "") return false;

    const branches = await FirestoreService.getAll<Branch>(BRANCH_COLLECTION, [
      { field: "id", operator: "==", value: normalizedBranchId },
    ]);
    if (branches.length === 0) return false;

    const branch = branches[0]!;
    return branch.businessId === businessId && branch.status !== "DELETED";
  }

  private async isServiceActiveInBusiness(
    serviceId: string,
    businessId: string
  ): Promise<boolean> {
    const normalizedServiceId = serviceId.trim();
    if (normalizedServiceId === "") return false;

    const services = await FirestoreService.getAll<Service>(SERVICES_COLLECTION, [
      { field: "id", operator: "==", value: normalizedServiceId },
    ]);
    if (services.length === 0) return false;

    const service = services[0]!;
    return service.businessId === businessId && service.status !== "DELETED";
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

  private isRevenueBookingStatus(status: AppointmentStatus): boolean {
    return (
      status === "CREATED" ||
      status === "IN_PROGRESS" ||
      status === "FINISHED"
    );
  }

  private roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private resolveBookingPaymentStatusFromBooking(
    booking: Booking
  ): BookingPaymentStatus {
    const totalAmount =
      Number.isFinite(booking.totalAmount) && booking.totalAmount >= 0
        ? booking.totalAmount
        : 0;
    const paidAmount =
      Number.isFinite(booking.paidAmount) && booking.paidAmount >= 0
        ? booking.paidAmount
        : 0;

    return this.resolveBookingPaymentStatus(totalAmount, paidAmount);
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
