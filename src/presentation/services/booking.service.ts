import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { FieldValue } from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import type { Appointment } from "../../domain/interfaces/appointment.interface";
import type { AppointmentStatus } from "../../domain/interfaces/appointment.interface";
import type {
  Booking,
  BookingPaymentStatus,
  BookingPaymentMethod,
  BookingStatus,
} from "../../domain/interfaces/booking.interface";
import { BOOKING_STATUSES } from "../../domain/interfaces/booking.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import type { Business } from "../../domain/interfaces/business.interface";
import type { Service } from "../../domain/interfaces/service.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import { normalizeBookingConsecutive } from "../../domain/utils/booking-consecutive.utils";
import type {
  CreateBookingAppointmentDto,
  CreateBookingDto,
} from "../booking/dtos/create-booking.dto";
import type {
  PublicManageBookingDto,
  UpdateBookingDto,
} from "../booking/dtos/update-booking.dto";
import { BOOKING_PAYMENT_METHOD_UPDATE_OPTIONS } from "../booking/dtos/update-booking-payment-method.dto";
import { BusinessUsageLimitService } from "./business-usage-limit.service";
import FirestoreService from "./firestore.service";
import { AppointmentService } from "./appointment.service";
import type {
  PreparedBookingScopedAppointmentMutation,
  ValidatedCreateAppointmentDraft,
} from "./appointment.service";
import { ReviewService } from "./review.service";
import type { AppointmentStatusTaskScheduler } from "./appointment-status-task-scheduler.service";
import { logger } from "../../infrastructure/logger/logger";
import type { WhatsAppService } from "./whatsapp.service";
import { UserService } from "./user.service";
import { BookingConsecutiveService } from "./booking-consecutive.service";
import type { PushNotificationService } from "./push-notification.service";
import { SchedulingIntegrityService } from "./scheduling-integrity.service";
import {
  ExternalDispatchAmbiguousError,
  ExternalDispatchService,
} from "./external-dispatch.service";
import { FirestoreConsistencyService } from "./firestore-consistency.service";
import { OutboxService } from "./outbox.service";

const BOOKINGS_COLLECTION = "Bookings";
const BUSINESSES_COLLECTION = "Businesses";
const APPOINTMENTS_COLLECTION = "Appointments";
const SERVICES_COLLECTION = "Services";
const BOOKING_PAYMENT_METHOD_ALLOWED_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  "CREATED",
  "IN_PROGRESS",
  "FINISHED",
];

interface UpdateBookingOptions {
  allowUnavailableBusinessForExistingAppointments?: boolean;
}

interface CreateBookingCoreCommitResult {
  bookingId: string;
  appointmentIds: string[];
  createdAt: string;
  metricsEventId: string;
  tasksEventId: string;
  whatsAppEventId: string;
  pushEventId: string;
}

interface ExternalDispatchExecution {
  channel: "WHATSAPP" | "PUSH";
  aggregateType: string;
  aggregateId: string;
}

type BookingAppointmentOperation = NonNullable<UpdateBookingDto["operations"]>[number];
type AddBookingAppointmentOperation = Extract<
  BookingAppointmentOperation,
  { op: "add" }
>;
type ExistingBookingAppointmentOperation = Exclude<
  BookingAppointmentOperation,
  { op: "add" }
>;

export class BookingService {
  constructor(
    private readonly appointmentService: AppointmentService = new AppointmentService(),
    private readonly reviewService: ReviewService = new ReviewService(),
    private readonly appointmentStatusTaskScheduler?: AppointmentStatusTaskScheduler,
    private readonly whatsAppService?: WhatsAppService,
    private readonly pushNotificationService?: PushNotificationService,
    private readonly userService: UserService = new UserService(),
    private readonly bookingConsecutiveService: BookingConsecutiveService =
      new BookingConsecutiveService(),
    private readonly businessUsageLimitService: BusinessUsageLimitService =
      new BusinessUsageLimitService(),
    private readonly schedulingIntegrityService: SchedulingIntegrityService =
      new SchedulingIntegrityService(),
    private readonly firestoreConsistencyService: FirestoreConsistencyService =
      new FirestoreConsistencyService(),
    private readonly outboxService: OutboxService = new OutboxService(),
    private readonly externalDispatchService: ExternalDispatchService =
      new ExternalDispatchService()
  ) {}

  async getAllBookings(
    params: PaginationParams & {
      id?: string;
      businessId?: string;
      clientId?: string;
      consecutive?: string;
      status?: BookingStatus;
      includeDeletes?: boolean;
    }
  ): Promise<PaginatedResult<Booking>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const requestedStatusRaw =
        typeof params.status === "string" && params.status.trim() !== ""
          ? params.status.trim().toUpperCase()
          : undefined;
      const requestedStatus = requestedStatusRaw as BookingStatus | undefined;

      if (requestedStatus != null && !BOOKING_STATUSES.includes(requestedStatus)) {
        throw CustomError.badRequest(
          "El estado debe ser creado, cancelado, finalizado o eliminado"
        );
      }

      const filters = [
        ...(requestedStatus != null
          ? [
              {
                field: "status" as const,
                operator: "==" as const,
                value: requestedStatus,
              },
            ]
          : !params.includeDeletes
          ? [
              {
                field: "status" as const,
                operator: "in" as const,
                value: ["CREATED", "CANCELLED", "FINISHED"],
              },
            ]
          : []),
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
        ...(params.clientId != null && params.clientId.trim() !== ""
          ? [
              {
                field: "clientId" as const,
                operator: "==" as const,
                value: params.clientId.trim(),
              },
            ]
          : []),
        ...(params.consecutive != null && params.consecutive.trim() !== ""
          ? [
              {
                field: "consecutive" as const,
                operator: "==" as const,
                value: normalizeBookingConsecutive(params.consecutive),
              },
            ]
          : []),
      ];

      const result = await FirestoreService.getAllPaginated<Booking>(
        BOOKINGS_COLLECTION,
        { page, pageSize },
        filters
      );
      return {
        ...result,
        data: result.data.map((booking) => this.normalizeBooking(booking)),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    try {
      if (dto.appointments.length === 0) {
        throw CustomError.badRequest(
          "Un booking debe incluir al menos un servicio/cita"
        );
      }
      this.appointmentService.clearValidationCache();

      const business = await FirestoreService.getById<Business>(
        BUSINESSES_COLLECTION,
        dto.businessId
      );
      const validatedDraftsResult =
        await this.appointmentService.validateDraftAppointmentsForNewBooking({
          businessId: dto.businessId,
          branchId: dto.branchId,
          appointments: dto.appointments,
        });
      const totalPrice = validatedDraftsResult.appointments.reduce(
        (sum, appointment) => sum + appointment.servicePrice,
        0
      );
      const paidAmount = dto.paidAmount ?? 0;
      if (paidAmount > totalPrice) {
        throw CustomError.badRequest(
          "paidAmount no puede ser mayor al totalAmount"
        );
      }
      const paymentStatus = this.resolvePaymentStatus(totalPrice, paidAmount);
      const consecutive = await this.bookingConsecutiveService.generateUniqueConsecutive(
        dto.businessId,
        business
      );

      await this.businessUsageLimitService.syncUsageStateForToday(dto.businessId);

      const coreCommit = await this.commitCreateBooking({
        dto,
        totalPrice,
        paidAmount,
        paymentStatus,
        consecutive,
        validatedAppointments: validatedDraftsResult.appointments,
      });

      const createdAppointments = this.buildCreatedAppointmentsFromDrafts(
        dto.businessId,
        coreCommit.bookingId,
        coreCommit.appointmentIds,
        coreCommit.createdAt,
        validatedDraftsResult.appointments
      );

      await this.runCreateBookingPostCommitWorkflows({
        dto,
        business,
        bookingId: coreCommit.bookingId,
        consecutive,
        paymentStatus,
        createdAppointments,
        validatedAppointments: validatedDraftsResult.appointments,
        metricsEventId: coreCommit.metricsEventId,
        tasksEventId: coreCommit.tasksEventId,
        whatsAppEventId: coreCommit.whatsAppEventId,
        pushEventId: coreCommit.pushEventId,
      });

      return await this.getBookingById(coreCommit.bookingId);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    } finally {
      this.appointmentService.clearValidationCache();
    }
  }

  private async commitCreateBooking(input: {
    dto: CreateBookingDto;
    totalPrice: number;
    paidAmount: number;
    paymentStatus: BookingPaymentStatus;
    consecutive: string;
    validatedAppointments: ValidatedCreateAppointmentDraft[];
  }): Promise<CreateBookingCoreCommitResult> {
    return this.firestoreConsistencyService.runTransaction(
      "BookingService.createBooking.coreCommit",
      async (context) => {
        await this.appointmentService.ensureClientForBusinessInTransaction(
          context,
          input.dto.businessId,
          {
            document: input.dto.clientId,
            ...(input.dto.clientDocumentTypeId !== undefined && {
              documentTypeId: input.dto.clientDocumentTypeId,
            }),
            ...(input.dto.clientDocumentTypeName !== undefined && {
              documentTypeName: input.dto.clientDocumentTypeName,
            }),
            ...(input.dto.clientName !== undefined && { name: input.dto.clientName }),
            ...(input.dto.clientPhone !== undefined && { phone: input.dto.clientPhone }),
            ...(input.dto.clientEmail !== undefined && { email: input.dto.clientEmail }),
          }
        );

        await this.businessUsageLimitService.consumeInTransaction(
          context,
          input.dto.businessId,
          "bookings",
          1
        );

        const bookingRef = context.doc(BOOKINGS_COLLECTION);
        const appointmentRefs = input.validatedAppointments.map(() =>
          context.doc(APPOINTMENTS_COLLECTION)
        );
        const appointmentIds = appointmentRefs.map((ref) => ref.id);

        context.transaction.set(bookingRef, {
          id: bookingRef.id,
          businessId: input.dto.businessId,
          branchId: input.dto.branchId,
          consecutive: input.consecutive,
          appointments: appointmentIds,
          clientId: input.dto.clientId,
          status: "CREATED" as const,
          totalAmount: input.totalPrice,
          paymentMethod: input.dto.paymentMethod,
          paidAmount: input.paidAmount,
          paymentStatus: input.paymentStatus,
          createdAt: context.now,
        });

        input.validatedAppointments.forEach((appointment, index) => {
          const appointmentRef = appointmentRefs[index]!;
          context.transaction.set(appointmentRef, {
            id: appointmentRef.id,
            businessId: input.dto.businessId,
            date: appointment.date,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
            serviceId: appointment.serviceId,
            employeeId: appointment.employeeId,
            status: "CREATED" as const,
            bookingId: bookingRef.id,
            createdAt: context.now,
          });
        });

        const metricsEvent = this.outboxService.enqueueInTransaction(context, {
          type: "BOOKING_METRICS_SYNC",
          aggregateType: "BOOKING",
          aggregateId: bookingRef.id,
          payload: {
            bookingId: bookingRef.id,
            businessId: input.dto.businessId,
            branchId: input.dto.branchId,
            paymentStatus: input.paymentStatus,
            beforeRevenueSnapshot: null,
            appointments: appointmentIds.map((appointmentId, index) => ({
              id: appointmentId,
              date: input.validatedAppointments[index]!.date,
              employeeId: input.validatedAppointments[index]!.employeeId,
              servicePrice: input.validatedAppointments[index]!.servicePrice,
            })),
          },
        });
        const tasksEvent = this.outboxService.enqueueInTransaction(context, {
          type: "APPOINTMENT_TASKS_SYNC",
          aggregateType: "BOOKING",
          aggregateId: bookingRef.id,
          payload: {
            bookingId: bookingRef.id,
            appointments: appointmentIds.map((appointmentId, index) => ({
              id: appointmentId,
              date: input.validatedAppointments[index]!.date,
              startTime: input.validatedAppointments[index]!.startTime,
              endTime: input.validatedAppointments[index]!.endTime,
            })),
          },
        });
        const whatsAppEvent = this.outboxService.enqueueInTransaction(context, {
          type: "BOOKING_CREATED_WHATSAPP",
          aggregateType: "BOOKING",
          aggregateId: bookingRef.id,
          payload: {
            bookingId: bookingRef.id,
            businessId: input.dto.businessId,
            clientDocument: input.dto.clientId,
            bookingConsecutive: input.consecutive,
          },
        });
        const pushEvent = this.outboxService.enqueueInTransaction(context, {
          type: "BOOKING_CREATED_PUSH",
          aggregateType: "BOOKING",
          aggregateId: bookingRef.id,
          payload: {
            bookingId: bookingRef.id,
            businessId: input.dto.businessId,
            branchId: input.dto.branchId,
            bookingConsecutive: input.consecutive,
            clientDocument: input.dto.clientId,
            appointments: appointmentIds.map((appointmentId, index) => ({
              id: appointmentId,
              date: input.validatedAppointments[index]!.date,
              startTime: input.validatedAppointments[index]!.startTime,
              employeeId: input.validatedAppointments[index]!.employeeId,
            })),
          },
        });

        return {
          bookingId: bookingRef.id,
          appointmentIds,
          createdAt: context.now.toDate().toISOString(),
          metricsEventId: metricsEvent.id,
          tasksEventId: tasksEvent.id,
          whatsAppEventId: whatsAppEvent.id,
          pushEventId: pushEvent.id,
        };
      }
    );
  }

  private buildCreatedAppointmentsFromDrafts(
    businessId: string,
    bookingId: string,
    appointmentIds: string[],
    createdAt: string,
    validatedAppointments: ValidatedCreateAppointmentDraft[]
  ): Appointment[] {
    return appointmentIds.map((appointmentId, index) => {
      const appointment = validatedAppointments[index]!;
      return {
        id: appointmentId,
        businessId,
        date: appointment.date,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        serviceId: appointment.serviceId,
        employeeId: appointment.employeeId,
        status: "CREATED",
        bookingId,
        createdAt,
      };
    });
  }

  private async runCreateBookingPostCommitWorkflows(input: {
    dto: CreateBookingDto;
    business: Business;
    bookingId: string;
    consecutive: string;
    paymentStatus: BookingPaymentStatus;
    createdAppointments: Appointment[];
    validatedAppointments: ValidatedCreateAppointmentDraft[];
    metricsEventId: string;
    tasksEventId: string;
    whatsAppEventId: string;
    pushEventId: string;
  }): Promise<void> {
    await this.executeTrackedOutboxStep(
      input.metricsEventId,
      `sincronizar métricas del booking ${input.bookingId}`,
      async () => {
        await this.appointmentService.applyCreatedAppointmentsMetrics({
          businessId: input.dto.businessId,
          branchId: input.dto.branchId,
          paymentStatus: input.paymentStatus,
          appointments: input.validatedAppointments.map((appointment) => ({
            date: appointment.date,
            employeeId: appointment.employeeId,
            servicePrice: appointment.servicePrice,
          })),
        });
        await this.appointmentService.syncBookingRevenueMetricsFromSnapshot(
          input.bookingId,
          null
        );
      }
    );

    await this.executeTrackedOutboxStep(
      input.tasksEventId,
      `programar tasks automáticas del booking ${input.bookingId}`,
      async () => {
        await this.scheduleStatusTasksForCreatedBookingAppointmentsStrict(
          input.createdAppointments
        );
      }
    );

    await this.executeTrackedOutboxStep(
      input.whatsAppEventId,
      `enviar WhatsApp de confirmación del booking ${input.bookingId}`,
      async () => {
        await this.sendBookingCreatedWhatsApp(
          input.bookingId,
          input.dto.businessId,
          input.consecutive,
          input.dto.clientId,
          { cachedBusiness: input.business }
        );
      },
      {
        externalDispatch: {
          channel: "WHATSAPP",
          aggregateType: "BOOKING",
          aggregateId: input.bookingId,
        },
      }
    );

    await this.executeTrackedOutboxStep(
      input.pushEventId,
      `enviar notificación push del booking ${input.bookingId}`,
      async () => {
        await this.sendBookingCreatedPushNotification({
          businessId: input.dto.businessId,
          branchId: input.dto.branchId,
          bookingId: input.bookingId,
          bookingConsecutive: input.consecutive,
          clientDocument: input.dto.clientId,
          employeeIds: input.createdAppointments.map(
            (appointment) => appointment.employeeId
          ),
          appointments: input.createdAppointments.map((appointment) => ({
            id: appointment.id,
            date: appointment.date,
            startTime: appointment.startTime,
          })),
        });
      },
      {
        externalDispatch: {
          channel: "PUSH",
          aggregateType: "BOOKING",
          aggregateId: input.bookingId,
        },
      }
    );
  }

  private async executeTrackedOutboxStep(
    eventId: string,
    description: string,
    action: () => Promise<void>,
    opts?: { externalDispatch?: ExternalDispatchExecution }
  ): Promise<void> {
    const claimedEvent = await this.outboxService.markProcessing(eventId).catch((error) => {
      if (
        error instanceof CustomError &&
        (error.statusCode === 404 || error.statusCode === 409)
      ) {
        return null;
      }
      throw error;
    });

    if (claimedEvent == null) {
      return;
    }

    try {
      if (opts?.externalDispatch) {
        await this.runExternalDispatchAction(
          eventId,
          description,
          opts.externalDispatch,
          action
        );
      } else {
        await action();
      }

      await this.outboxService.markDone(eventId).catch((outboxError) => {
        const detail =
          outboxError instanceof Error
            ? outboxError.message
            : typeof outboxError === "string"
              ? outboxError
              : JSON.stringify(outboxError);
        logger.warn(
            `[BookingService] El side effect '${description}' se ejecutó, pero no se pudo marcar DONE el outbox ${eventId}. detalle=${detail}`
        );
      });
    } catch (error) {
      if (error instanceof ExternalDispatchAmbiguousError) {
        logger.warn(
          `[BookingService] Se pausó el outbox ${eventId} por envío externo ambiguo. detalle=${error.message}`
        );
        await this.outboxService.markPaused(eventId, error.message).catch((outboxError) => {
          const outboxDetail =
            outboxError instanceof Error
              ? outboxError.message
              : typeof outboxError === "string"
                ? outboxError
                : JSON.stringify(outboxError);
          logger.warn(
            `[BookingService] Además no se pudo marcar PAUSED el outbox ${eventId}. detalle=${outboxDetail}`
          );
        });
        return;
      }

      const detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      logger.warn(`[BookingService] No se pudo ${description}. detalle=${detail}`);
      await this.outboxService.markError(eventId, detail).catch((outboxError) => {
        const outboxDetail =
          outboxError instanceof Error
            ? outboxError.message
            : typeof outboxError === "string"
              ? outboxError
              : JSON.stringify(outboxError);
        logger.warn(
          `[BookingService] Además no se pudo marcar ERROR el outbox ${eventId}. detalle=${outboxDetail}`
        );
      });
    }
  }

  private async runExternalDispatchAction(
    eventId: string,
    description: string,
    execution: ExternalDispatchExecution,
    action: () => Promise<void>
  ): Promise<void> {
    const beginResult = await this.externalDispatchService.begin({
      dispatchId: eventId,
      channel: execution.channel,
      aggregateType: execution.aggregateType,
      aggregateId: execution.aggregateId,
      description,
    });

    if (beginResult === "ALREADY_SUCCEEDED") {
      return;
    }

    try {
      await action();
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      await this.externalDispatchService.markFailed(eventId, detail).catch(() => undefined);
      throw error;
    }

    try {
      await this.externalDispatchService.markSucceeded(eventId);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      await this.externalDispatchService
        .markAmbiguous(
          eventId,
          `El side effect '${description}' se ejecutó, pero no se pudo confirmar su persistencia. detalle=${detail}`
        )
        .catch(() => undefined);

      throw new ExternalDispatchAmbiguousError(
        eventId,
        `El side effect '${description}' quedó ambiguo después de ejecutarse`
      );
    }
  }

  async replayBookingCreatedWhatsAppEvent(
    eventId: string,
    input: {
    bookingId: string;
    businessId: string;
    clientDocument: string;
    bookingConsecutive: string;
  }): Promise<void> {
    await this.runExternalDispatchAction(
      eventId,
      `enviar WhatsApp de confirmación del booking ${input.bookingId}`,
      {
        channel: "WHATSAPP",
        aggregateType: "BOOKING",
        aggregateId: input.bookingId,
      },
      async () => {
        const booking = await this.getBookingById(input.bookingId).catch((error) => {
          if (error instanceof CustomError && error.statusCode === 404) {
            return null;
          }
          throw error;
        });

        if (booking == null || booking.status !== "CREATED") {
          return;
        }

        await this.sendBookingCreatedWhatsApp(
          input.bookingId,
          input.businessId,
          input.bookingConsecutive,
          input.clientDocument
        );
      }
    );
  }

  async replayBookingCreatedPushEvent(
    eventId: string,
    input: {
    bookingId: string;
    businessId: string;
    branchId: string;
    bookingConsecutive: string;
    clientDocument: string;
    appointments: Array<{
      id: string;
      date: string;
      startTime: string;
      employeeId: string;
    }>;
  }): Promise<void> {
    await this.runExternalDispatchAction(
      eventId,
      `enviar notificación push del booking ${input.bookingId}`,
      {
        channel: "PUSH",
        aggregateType: "BOOKING",
        aggregateId: input.bookingId,
      },
      async () => {
        const booking = await this.getBookingById(input.bookingId).catch((error) => {
          if (error instanceof CustomError && error.statusCode === 404) {
            return null;
          }
          throw error;
        });

        if (booking == null || booking.status !== "CREATED") {
          return;
        }

        await this.sendBookingCreatedPushNotification({
          businessId: input.businessId,
          branchId: input.branchId,
          bookingId: input.bookingId,
          bookingConsecutive: input.bookingConsecutive,
          clientDocument: input.clientDocument,
          employeeIds: input.appointments.map((appointment) => appointment.employeeId),
          appointments: input.appointments.map((appointment) => ({
            id: appointment.id,
            date: appointment.date,
            startTime: appointment.startTime,
          })),
        });
      }
    );
  }

  async addPayment(id: string, amount: number): Promise<Booking> {
    try {
      const booking = await this.getBookingById(id);
      const beforeRevenueSnapshot =
        await this.appointmentService.captureBookingRevenueSnapshot(id);

      if (booking.status === "DELETED" || booking.status === "CANCELLED") {
        throw CustomError.badRequest(
          "No se pueden registrar abonos en un agendamiento cancelado o eliminado"
        );
      }

      const remainingAmount = Math.max(0, booking.totalAmount - booking.paidAmount);
      if (remainingAmount <= 0) {
        throw CustomError.badRequest(
          "El agendamiento ya no tiene saldo pendiente por pagar"
        );
      }

      if (amount > remainingAmount) {
        throw CustomError.badRequest(
          "El abono no puede ser mayor al monto faltante del agendamiento"
        );
      }

      const nextPaidAmount = booking.paidAmount + amount;
      const nextPaymentStatus = this.resolvePaymentStatus(
        booking.totalAmount,
        nextPaidAmount
      );

      await FirestoreService.update(BOOKINGS_COLLECTION, id, {
        paidAmount: nextPaidAmount,
        paymentStatus: nextPaymentStatus,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      await this.appointmentService.syncBookingRevenueMetricsFromSnapshot(
        id,
        beforeRevenueSnapshot
      );

      return await this.getBookingById(id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updatePaymentMethod(
    id: string,
    paymentMethod: (typeof BOOKING_PAYMENT_METHOD_UPDATE_OPTIONS)[number]
  ): Promise<Booking> {
    try {
      const booking = await this.getBookingById(id);
      if (booking.status === "DELETED" || booking.status === "CANCELLED") {
        throw CustomError.badRequest(
          "No se puede cambiar el medio de pago de un agendamiento cancelado o eliminado"
        );
      }

      const appointments = await this.appointmentService.getAppointmentsByIds(
        booking.appointments
      );
      const canEditPaymentMethod = appointments.some((appointment) =>
        BOOKING_PAYMENT_METHOD_ALLOWED_APPOINTMENT_STATUSES.includes(
          appointment.status
        )
      );

      if (!canEditPaymentMethod) {
        throw CustomError.badRequest(
          "Solo se puede cambiar el medio de pago cuando el agendamiento tiene citas en estado creado, en progreso o finalizado"
        );
      }

      if (booking.paymentMethod === paymentMethod) {
        return booking;
      }

      await FirestoreService.update(BOOKINGS_COLLECTION, id, {
        paymentMethod,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      return await this.getBookingById(id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updateBooking(id: string, dto: UpdateBookingDto): Promise<Booking> {
    return this.updateBookingInternal(id, dto);
  }

  async publicManageBooking(
    id: string,
    dto: PublicManageBookingDto
  ): Promise<Booking> {
    return this.updateBookingInternal(id, dto, {
      allowUnavailableBusinessForExistingAppointments: true,
    });
  }

  private async updateBookingInternal(
    id: string,
    dto: UpdateBookingDto,
    opts?: UpdateBookingOptions
  ): Promise<Booking> {
    try {
      const existingBooking = await this.getBookingById(id);
      const beforeRevenueSnapshot =
        await this.appointmentService.captureBookingRevenueSnapshot(id);
      const allowUnavailableBusinessForExistingAppointments =
        opts?.allowUnavailableBusinessForExistingAppointments === true;
      const hasBookingEditChanges =
        dto.branchId !== undefined ||
        dto.clientId !== undefined ||
        dto.clientDocumentTypeId !== undefined ||
        dto.clientDocumentTypeName !== undefined ||
        dto.clientName !== undefined ||
        dto.clientPhone !== undefined ||
        dto.clientEmail !== undefined ||
        dto.paymentMethod !== undefined ||
        dto.paidAmount !== undefined ||
        dto.operations !== undefined;
      const effectiveDto = this.normalizeUpdateBookingDtoForEditProjection(
        dto,
        hasBookingEditChanges
      );

      if (
        hasBookingEditChanges &&
        (existingBooking.status === "DELETED" ||
          existingBooking.status === "CANCELLED" ||
          existingBooking.status === "FINISHED")
      ) {
        throw CustomError.badRequest(
          "No se puede editar un agendamiento con estado finalizado, eliminado o cancelado"
        );
      }

      const nextBranchId = effectiveDto.branchId ?? existingBooking.branchId;
      let nextBranchForValidation: Branch | null = null;
      if (
        effectiveDto.branchId !== undefined &&
        effectiveDto.branchId.trim() !== existingBooking.branchId.trim()
      ) {
        nextBranchForValidation = await this.appointmentService.ensureBusinessAndBranch(
          existingBooking.businessId,
          nextBranchId,
          {
            allowUnavailableBusiness:
              allowUnavailableBusinessForExistingAppointments,
          }
        );
      }

      if (effectiveDto.clientId !== undefined) {
        await this.appointmentService.ensureClientForBusiness(
          existingBooking.businessId,
          {
            document: effectiveDto.clientId,
            ...(effectiveDto.clientDocumentTypeId !== undefined && {
              documentTypeId: effectiveDto.clientDocumentTypeId,
            }),
            ...(effectiveDto.clientDocumentTypeName !== undefined && {
              documentTypeName: effectiveDto.clientDocumentTypeName,
            }),
            ...(effectiveDto.clientName !== undefined && { name: effectiveDto.clientName }),
            ...(effectiveDto.clientPhone !== undefined && { phone: effectiveDto.clientPhone }),
            ...(effectiveDto.clientEmail !== undefined && { email: effectiveDto.clientEmail }),
          }
        );
      }

      const isDeletingBooking = effectiveDto.status === "DELETED";
      let cachedServices: Service[] | undefined;
      if (!isDeletingBooking) {
        cachedServices = await this.ensureServicesEditableForBookingUpdate(
          existingBooking.businessId,
          effectiveDto
        );
      }
      this.ensureBookingOperationsNotInPast(effectiveDto);

      if (this.canUseProjectedBookingStatusFlow(effectiveDto, hasBookingEditChanges)) {
        return await this.updateBookingWithProjectedStatusOnlyFlow({
          existingBooking,
          nextStatus: effectiveDto.status!,
          beforeRevenueSnapshot,
          allowUnavailableBusinessForExistingAppointments,
        });
      }

      if (this.canUseProjectedAddOnlyOperationsFlow(effectiveDto)) {
        return await this.updateBookingWithProjectedAddOperations({
          existingBooking,
          dto: effectiveDto,
          nextBranchId,
          nextBranchForValidation,
          cachedServices,
          beforeRevenueSnapshot,
          allowUnavailableBusinessForExistingAppointments,
        });
      }

      if (this.canUseProjectedExistingAppointmentOperationsFlow(effectiveDto)) {
        return await this.updateBookingWithProjectedExistingAppointmentOperations({
          existingBooking,
          dto: effectiveDto,
          nextBranchId,
          nextBranchForValidation,
          cachedServices,
          beforeRevenueSnapshot,
          allowUnavailableBusinessForExistingAppointments,
        });
      }

      if (
        effectiveDto.operations != null &&
        effectiveDto.operations.length > 0
      ) {
        return await this.updateBookingWithProjectedStagedOperations(
          id,
          effectiveDto,
          opts
        );
      }

      const appointmentIds = new Set(existingBooking.appointments);

      if (effectiveDto.operations != null) {
        for (const operation of effectiveDto.operations) {
          if (operation.op === "add") {
            const createdAppointment =
              await this.appointmentService.createAppointmentForBooking({
                bookingId: existingBooking.id,
                date: operation.date,
                startTime: operation.startTime,
                endTime: operation.endTime,
                serviceId: operation.serviceId,
                employeeId: operation.employeeId,
              });
            appointmentIds.add(createdAppointment.id);
            continue;
          }

          const appointment = await this.ensureAppointmentBelongsToBooking(
            existingBooking.id,
            operation.appointmentId
          );
          appointmentIds.add(appointment.id);

          if (operation.op === "cancel") {
            if (appointment.status !== "DELETED") {
              await this.appointmentService.cancelAppointment(operation.appointmentId, {
                skipBookingSync: true,
              });
            }
            continue;
          }

          if (appointment.status === "DELETED") {
            throw CustomError.badRequest(
              "No se puede editar una cita eliminada"
            );
          }
          if (appointment.status === "IN_PROGRESS") {
            throw CustomError.badRequest(
              "No se puede editar una cita en curso"
            );
          }

          await this.appointmentService.updateAppointment(
            operation.appointmentId,
            {
              date: operation.date,
              startTime: operation.startTime,
              endTime: operation.endTime,
              serviceId: operation.serviceId,
              employeeId: operation.employeeId,
            },
            {
              branchIdOverride: nextBranchId,
              skipBookingSync: true,
              allowUnavailableBusiness:
                allowUnavailableBusinessForExistingAppointments,
            }
          );
        }
      }

      const normalizedAppointmentIds = Array.from(appointmentIds);
      if (normalizedAppointmentIds.length === 0 && !isDeletingBooking) {
        throw CustomError.badRequest(
          "Un booking debe incluir al menos un servicio/cita"
        );
      }

      if (nextBranchForValidation != null) {
        await this.schedulingIntegrityService.ensureActiveAppointmentsRespectBranchSchedule(
          {
            appointmentIds: normalizedAppointmentIds,
            schedule: nextBranchForValidation.schedule,
            fallbackBookingId: existingBooking.id,
            errorMessagePrefix:
              "No se puede mover el agendamiento a la sede seleccionada porque hay citas activas fuera del horario de esa sede",
          }
        );
      }

      let cancellationNotificationAppointments: Appointment[] = [];
      if (
        !hasBookingEditChanges &&
        dto.status === "CANCELLED" &&
        existingBooking.status !== "CANCELLED"
      ) {
        cancellationNotificationAppointments = (
          await this.appointmentService.getAppointmentsByIds(normalizedAppointmentIds)
        ).filter((appointment) => appointment.status !== "DELETED");
      }

      let totalAmount = existingBooking.totalAmount;
      let paidAmount = effectiveDto.paidAmount ?? existingBooking.paidAmount;
      let paymentStatus = existingBooking.paymentStatus;
      if (!isDeletingBooking) {
        totalAmount = await this.calculateTotalPriceFromAppointments(
          existingBooking.businessId,
          normalizedAppointmentIds,
          cachedServices,
          { includeDeletedServices: effectiveDto.status === "FINISHED" }
        );
        if (paidAmount > totalAmount) {
          throw CustomError.badRequest(
            "paidAmount no puede ser mayor al totalAmount"
          );
        }
        paymentStatus = this.resolvePaymentStatus(totalAmount, paidAmount);
      }

      if (hasBookingEditChanges || dto.status === "CREATED") {
        await this.ensureBookingCanBeMarkedCreated(
          existingBooking.businessId,
          nextBranchId,
          normalizedAppointmentIds,
          {
            allowUnavailableBusiness:
              allowUnavailableBusinessForExistingAppointments,
          }
        );
      }

      const payload: Record<string, unknown> = {
        appointments: normalizedAppointmentIds,
        totalAmount,
        paidAmount,
        paymentStatus,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };

      if (dto.branchId !== undefined) {
        payload.branchId = nextBranchId;
      }

      if (dto.clientId !== undefined) {
        payload.clientId = dto.clientId;
      }
      if (dto.paymentMethod !== undefined) {
        payload.paymentMethod = dto.paymentMethod;
      }

      if (hasBookingEditChanges) {
        payload.status = "CREATED";
        payload.cancelledAt = FieldValue.delete();
        payload.deletedAt = FieldValue.delete();
      } else if (effectiveDto.status !== undefined) {
        await this.ensureBookingStatusTransitionAllowed(
          existingBooking.status,
          effectiveDto.status,
          normalizedAppointmentIds
        );
        if (effectiveDto.status === "DELETED") {
          await this.reviewService.deleteReviewsByAppointmentIds(
            normalizedAppointmentIds
          );
        }
        await this.applyStatusToAppointments(effectiveDto.status, normalizedAppointmentIds);
        payload.status = effectiveDto.status;

        if (effectiveDto.status === "CANCELLED") {
          payload.cancelledAt = FirestoreDataBase.generateTimeStamp();
          payload.deletedAt = FieldValue.delete();
        } else if (effectiveDto.status === "DELETED") {
          payload.deletedAt = FirestoreDataBase.generateTimeStamp();
          payload.cancelledAt = FieldValue.delete();
        } else {
          payload.cancelledAt = FieldValue.delete();
          payload.deletedAt = FieldValue.delete();
        }

        payload.totalAmount = totalAmount;
        payload.paidAmount = paidAmount;
        payload.paymentStatus = paymentStatus;
      }

      await FirestoreService.update(BOOKINGS_COLLECTION, id, payload);

      await this.appointmentService.syncBookingRevenueMetricsFromSnapshot(
        id,
        beforeRevenueSnapshot
      );

      if (effectiveDto.status === "DELETED" && existingBooking.status !== "DELETED") {
        await this.businessUsageLimitService.release(
          existingBooking.businessId,
          "bookings",
          1
        );
      }

      if (
        !hasBookingEditChanges &&
        effectiveDto.status !== undefined &&
        (effectiveDto.status === "CANCELLED" || effectiveDto.status === "DELETED") &&
        existingBooking.status !== effectiveDto.status &&
        existingBooking.status !== "FINISHED" &&
        !(
          effectiveDto.status === "DELETED" &&
          existingBooking.status === "CANCELLED"
        )
      ) {
        await this.sendBookingStatusChangedWhatsApp(
          existingBooking.businessId,
          existingBooking.clientId,
          existingBooking.consecutive
        ).catch((whatsAppError) => {
          const detail =
            whatsAppError instanceof Error
              ? whatsAppError.message
              : typeof whatsAppError === "string"
                ? whatsAppError
                : JSON.stringify(whatsAppError);

          logger.warn(
            `[BookingService] No se pudo enviar WhatsApp de ${effectiveDto.status} para booking ${existingBooking.id}. detalle=${detail}`
          );
        });
      }

      if (
        !hasBookingEditChanges &&
        effectiveDto.status === "FINISHED" &&
        existingBooking.status !== "FINISHED"
      ) {
        await this.sendBookingFinishedWhatsApp(
          existingBooking.id,
          existingBooking.businessId,
          existingBooking.clientId,
          existingBooking.consecutive
        ).catch((whatsAppError) => {
          const detail =
            whatsAppError instanceof Error
              ? whatsAppError.message
              : typeof whatsAppError === "string"
                ? whatsAppError
                : JSON.stringify(whatsAppError);

          logger.warn(
            `[BookingService] No se pudo enviar WhatsApp de FINISHED para booking ${existingBooking.id}. detalle=${detail}`
          );
        });
      }

      if (
        !hasBookingEditChanges &&
        effectiveDto.status === "CANCELLED" &&
        existingBooking.status !== "CANCELLED"
      ) {
        await this.pushNotificationService
          ?.notifyBookingCancelled({
            businessId: existingBooking.businessId,
            branchId: existingBooking.branchId,
            bookingId: existingBooking.id,
            bookingConsecutive: existingBooking.consecutive,
            clientDocument: existingBooking.clientId,
            employeeIds: cancellationNotificationAppointments.map(
              (appointment) => appointment.employeeId
            ),
            appointments: cancellationNotificationAppointments.map((appointment) => ({
              id: appointment.id,
              date: appointment.date,
              startTime: appointment.startTime,
            })),
          })
          .catch((pushNotificationError) => {
            const detail =
              pushNotificationError instanceof Error
                ? pushNotificationError.message
                : typeof pushNotificationError === "string"
                  ? pushNotificationError
                  : JSON.stringify(pushNotificationError);

            logger.warn(
              `[BookingService] No se pudo enviar notificación push de cancelación para booking ${existingBooking.id}. detalle=${detail}`
            );
          });
      }

      return await this.getBookingById(id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteBooking(id: string): Promise<Booking> {
    try {
      return await this.updateBooking(id, { status: "DELETED" });
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
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
        : FirestoreService.getById<Business>(BUSINESSES_COLLECTION, businessId),
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
      `[BookingService] WhatsApp de confirmacion aceptado por Infobip. bookingId=${bookingId}, to=${phone}, templateType=APPOINTMENT_CONFIRMATION, messageId=${sendResult.messageId}`
    );
  }

  private async sendBookingCreatedPushNotification(input: {
    businessId: string;
    branchId: string;
    bookingId: string;
    bookingConsecutive: string;
    clientDocument: string;
    employeeIds: string[];
    appointments: Array<{
      id: string;
      date: string;
      startTime: string;
    }>;
  }): Promise<void> {
    if (this.pushNotificationService == null) return;

    await this.pushNotificationService.notifyBookingCreated({
      businessId: input.businessId,
      branchId: input.branchId,
      bookingId: input.bookingId,
      bookingConsecutive: input.bookingConsecutive,
      clientDocument: input.clientDocument,
      employeeIds: input.employeeIds,
      appointments: input.appointments,
    });
  }

  private async sendBookingStatusChangedWhatsApp(
    businessId: string,
    clientDocument: string,
    bookingConsecutive: string,
    opts?: { cachedBusiness?: Business }
  ): Promise<void> {
    if (this.whatsAppService == null) return;

    const sanitizedDocument = clientDocument.trim();
    if (sanitizedDocument === "") return;

    const [user, business] = await Promise.all([
      this.userService.getByDocument(sanitizedDocument),
      opts?.cachedBusiness
        ? Promise.resolve(opts.cachedBusiness)
        : FirestoreService.getById<Business>(BUSINESSES_COLLECTION, businessId),
    ]);
    const phone = user?.phone?.trim() ?? "";
    if (phone === "") return;
    const businessName = business.name?.trim() || "Cutlyy";
    const businessSlug = business.slug?.trim() ?? "";
    if (businessSlug === "") {
      throw CustomError.internalServerError(
        `El negocio ${businessId} no tiene slug configurado para enviar WhatsApp`
      );
    }
    const clientName = user?.name?.trim() || "cliente";

    const sendResult = await this.whatsAppService.sendTemplateMessage({
      to: phone,
      templateType: "APPOINTMENT_MODIFICATION",
      headerPlaceholders: [businessName],
      bodyPlaceholders: [clientName, bookingConsecutive],
      buttons: [
        {
          type: "URL",
          parameter: businessSlug,
        },
      ],
    });

    logger.info(
      `[BookingService] WhatsApp de cancelacion aceptado por Infobip. businessId=${businessId}, to=${phone}, templateType=APPOINTMENT_MODIFICATION, messageId=${sendResult.messageId}`
    );
  }

  private async sendBookingFinishedWhatsApp(
    bookingId: string,
    businessId: string,
    clientDocument: string,
    bookingConsecutive: string,
    opts?: { cachedBusiness?: Business }
  ): Promise<void> {
    if (this.whatsAppService == null) return;

    const sanitizedDocument = clientDocument.trim();
    if (sanitizedDocument === "") return;

    const [user, business] = await Promise.all([
      this.userService.getByDocument(sanitizedDocument),
      opts?.cachedBusiness
        ? Promise.resolve(opts.cachedBusiness)
        : FirestoreService.getById<Business>(BUSINESSES_COLLECTION, businessId),
    ]);
    const phone = user?.phone?.trim() ?? "";
    if (phone === "") return;
    const businessName = business.name?.trim() || "Cutlyy";
    const clientName = user?.name?.trim() || "cliente";

    const sendResult = await this.whatsAppService.sendTemplateMessage({
      to: phone,
      templateType: "APPOINTMENT_COMPLETION",
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
      `[BookingService] WhatsApp de finalizacion aceptado por Infobip. bookingId=${bookingId}, to=${phone}, templateType=APPOINTMENT_COMPLETION, messageId=${sendResult.messageId}`
    );
  }

  private async scheduleStatusTasksForCreatedBookingAppointments(
    appointments: Appointment[]
  ): Promise<void> {
    const scheduler = this.appointmentStatusTaskScheduler;
    if (scheduler == null || appointments.length === 0) return;

    await Promise.all(
      appointments.map((appointment) =>
        scheduler
          .scheduleAppointmentStatusTasks({
            appointmentId: appointment.id,
            date: appointment.date,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
          })
          .catch((taskError) => {
            const detail =
              taskError instanceof Error
                ? taskError.message
                : typeof taskError === "string"
                  ? taskError
                  : JSON.stringify(taskError);

            logger.warn(
              `[BookingService] No se pudieron crear tasks automáticas para appointment ${appointment.id}. detalle=${detail}`
            );
          })
      )
    );
  }

  private async scheduleStatusTasksForCreatedBookingAppointmentsStrict(
    appointments: Appointment[]
  ): Promise<void> {
    const scheduler = this.appointmentStatusTaskScheduler;
    if (scheduler == null || appointments.length === 0) return;

    await Promise.all(
      appointments.map((appointment) =>
        scheduler.scheduleAppointmentStatusTasks({
          appointmentId: appointment.id,
          date: appointment.date,
          startTime: appointment.startTime,
          endTime: appointment.endTime,
        })
      )
    );
  }

  private async compensateFailedCreation(
    bookingId: string | null,
    appointmentIds: string[]
  ): Promise<void> {
    try {
      const db = FirestoreDataBase.getDB();
      const batch = db.batch();
      const deletedAt = FirestoreDataBase.generateTimeStamp();

      for (const appointmentId of appointmentIds) {
        batch.update(db.collection(APPOINTMENTS_COLLECTION).doc(appointmentId), {
          status: "DELETED",
          deletedAt,
        });
      }

      if (bookingId) {
        batch.update(db.collection(BOOKINGS_COLLECTION).doc(bookingId), {
          appointments: appointmentIds,
          status: "DELETED",
          deletedAt,
          updatedAt: deletedAt,
        });
      }

      await batch.commit();
    } catch {
      // Compensación best-effort: si falla el batch, no propagamos el error
    }
  }

  private async calculateTotalPrice(
    businessId: string,
    appointmentInputs: CreateBookingAppointmentDto[]
  ): Promise<number> {
    const requestedServiceIds = appointmentInputs.map(
      (appointment) => appointment.serviceId
    );
    return this.calculateTotalPriceFromServiceIds(businessId, requestedServiceIds);
  }

  private async calculateTotalPriceFromAppointments(
    businessId: string,
    appointmentIds: string[],
    cachedServices?: Service[],
    opts?: { includeDeletedServices?: boolean }
  ): Promise<number> {
    if (appointmentIds.length === 0) return 0;

    const appointments = await this.appointmentService.getAppointmentsByIds(appointmentIds);
    const activeServiceIds = appointments
      .filter(
        (appointment) =>
          appointment.status !== "CANCELLED" && appointment.status !== "DELETED"
      )
      .map((appointment) => appointment.serviceId.trim())
      .filter((serviceId) => serviceId !== "");

    return this.calculateTotalPriceFromServiceIds(
      businessId,
      activeServiceIds,
      cachedServices,
      opts
    );
  }

  private buildProjectedOperationStageDtos(dto: UpdateBookingDto): UpdateBookingDto[] {
    const operations = dto.operations ?? [];
    if (operations.length === 0) return [];

    const existingStages = this.partitionExistingAppointmentOperations(operations);
    const addOperations = operations.filter(
      (operation): operation is AddBookingAppointmentOperation => operation.op === "add"
    );
    const totalStages = existingStages.length + (addOperations.length > 0 ? 1 : 0);

    return [
      ...existingStages.map((operations, index) =>
        this.buildProjectedOperationStageDto({
          dto,
          operations,
          isFinalStage: addOperations.length === 0 && index === totalStages - 1,
          includeBranchForValidation: true,
        })
      ),
      ...(addOperations.length > 0
        ? [
            this.buildProjectedOperationStageDto({
              dto,
              operations: addOperations,
              isFinalStage: true,
              includeBranchForValidation: true,
            }),
          ]
        : []),
    ];
  }

  private buildProjectedOperationStageDto(input: {
    dto: UpdateBookingDto;
    operations: BookingAppointmentOperation[];
    isFinalStage: boolean;
    includeBranchForValidation: boolean;
  }): UpdateBookingDto {
    return {
      ...(input.includeBranchForValidation &&
        input.dto.branchId !== undefined && { branchId: input.dto.branchId }),
      ...(input.isFinalStage &&
        input.dto.clientId !== undefined && { clientId: input.dto.clientId }),
      ...(input.isFinalStage &&
        input.dto.clientDocumentTypeId !== undefined && {
          clientDocumentTypeId: input.dto.clientDocumentTypeId,
        }),
      ...(input.isFinalStage &&
        input.dto.clientDocumentTypeName !== undefined && {
          clientDocumentTypeName: input.dto.clientDocumentTypeName,
        }),
      ...(input.isFinalStage &&
        input.dto.clientName !== undefined && { clientName: input.dto.clientName }),
      ...(input.isFinalStage &&
        input.dto.clientPhone !== undefined && { clientPhone: input.dto.clientPhone }),
      ...(input.isFinalStage &&
        input.dto.clientEmail !== undefined && { clientEmail: input.dto.clientEmail }),
      ...(input.isFinalStage &&
        input.dto.paymentMethod !== undefined && {
          paymentMethod: input.dto.paymentMethod,
        }),
      ...(input.isFinalStage &&
        input.dto.paidAmount !== undefined && { paidAmount: input.dto.paidAmount }),
      operations: input.operations,
    };
  }

  private partitionExistingAppointmentOperations(
    operations: BookingAppointmentOperation[]
  ): ExistingBookingAppointmentOperation[][] {
    const stages: ExistingBookingAppointmentOperation[][] = [];
    let currentStage: ExistingBookingAppointmentOperation[] = [];
    let currentStageTargets = new Set<string>();

    operations.forEach((operation) => {
      if (operation.op === "add") return;

      const appointmentId = operation.appointmentId.trim();
      if (currentStageTargets.has(appointmentId) && currentStage.length > 0) {
        stages.push(currentStage);
        currentStage = [];
        currentStageTargets = new Set<string>();
      }

      currentStage.push(operation);
      currentStageTargets.add(appointmentId);
    });

    if (currentStage.length > 0) {
      stages.push(currentStage);
    }

    return stages;
  }

  private canUseProjectedExistingAppointmentOperationsFlow(
    dto: UpdateBookingDto
  ): boolean {
    if (
      (dto.status !== undefined && dto.status !== "CREATED") ||
      dto.operations == null ||
      dto.operations.length === 0
    ) {
      return false;
    }

    if (dto.operations.some((operation) => operation.op === "add")) {
      return false;
    }

    const operationTargets = dto.operations
      .filter((operation) => operation.op !== "add")
      .map((operation) => operation.appointmentId);
    return new Set(operationTargets).size === operationTargets.length;
  }

  private canUseProjectedAddOnlyOperationsFlow(dto: UpdateBookingDto): boolean {
    if (
      (dto.status !== undefined && dto.status !== "CREATED") ||
      dto.operations == null ||
      dto.operations.length === 0
    ) {
      return false;
    }

    return dto.operations.every((operation) => operation.op === "add");
  }

  private canUseProjectedBookingStatusFlow(
    dto: UpdateBookingDto,
    hasBookingEditChanges: boolean
  ): boolean {
    return !hasBookingEditChanges && dto.status !== undefined;
  }

  private async updateBookingWithProjectedExistingAppointmentOperations(input: {
    existingBooking: Booking;
    dto: UpdateBookingDto;
    nextBranchId: string;
    nextBranchForValidation: Branch | null;
    cachedServices: Service[] | undefined;
    beforeRevenueSnapshot: Awaited<
      ReturnType<AppointmentService["captureBookingRevenueSnapshot"]>
    >;
    allowUnavailableBusinessForExistingAppointments: boolean;
  }): Promise<Booking> {
    const currentAppointments = await this.appointmentService.getAppointmentsByIds(
      input.existingBooking.appointments
    );
    const projectedAppointmentsById = new Map(
      currentAppointments.map((appointment) => [appointment.id, appointment] as const)
    );
    const appointmentPlans: PreparedBookingScopedAppointmentMutation[] = [];

    const projectedOperations = (input.dto.operations ?? []).filter(
      (
        operation
      ): operation is Exclude<
        NonNullable<UpdateBookingDto["operations"]>[number],
        { op: "add" }
      > => operation.op !== "add"
    );

    for (const operation of projectedOperations) {
      await this.ensureAppointmentBelongsToBooking(
        input.existingBooking.id,
        operation.appointmentId
      );

      const appointmentPlan =
        operation.op === "cancel"
          ? await this.appointmentService.prepareCancelAppointmentForBookingMutation(
              operation.appointmentId
            )
          : await this.appointmentService.prepareUpdateAppointmentForBookingMutation(
              operation.appointmentId,
              {
                date: operation.date,
                startTime: operation.startTime,
                endTime: operation.endTime,
                serviceId: operation.serviceId,
                employeeId: operation.employeeId,
              },
              {
                branchIdOverride: input.nextBranchId,
                allowUnavailableBusiness:
                  input.allowUnavailableBusinessForExistingAppointments,
              }
            );

      projectedAppointmentsById.set(
        appointmentPlan.projectedAppointment.id,
        appointmentPlan.projectedAppointment
      );
      appointmentPlans.push(appointmentPlan);
    }

    const normalizedAppointmentIds = Array.from(
      new Set(input.existingBooking.appointments)
    );
    const projectedAppointments = currentAppointments.map(
      (appointment) => projectedAppointmentsById.get(appointment.id) ?? appointment
    );

    if (normalizedAppointmentIds.length === 0) {
      throw CustomError.badRequest(
        "Un booking debe incluir al menos un servicio/cita"
      );
    }

    if (input.nextBranchForValidation != null) {
      await this.schedulingIntegrityService.ensureAppointmentCandidatesRespectBranchSchedule(
        {
          appointments: projectedAppointments.map((appointment) => ({
            id: appointment.id,
            bookingId: appointment.bookingId,
            date: appointment.date,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
            status: appointment.status,
          })),
          schedule: input.nextBranchForValidation.schedule,
          fallbackBookingId: input.existingBooking.id,
          errorMessagePrefix:
            "No se puede mover el agendamiento a la sede seleccionada porque hay citas activas fuera del horario de esa sede",
        }
      );
    }

    const projectedActiveServiceIds = projectedAppointments
      .filter(
        (appointment) =>
          appointment.status !== "CANCELLED" && appointment.status !== "DELETED"
      )
      .map((appointment) => appointment.serviceId.trim())
      .filter((serviceId) => serviceId !== "");

    const totalAmount = await this.calculateTotalPriceFromServiceIds(
      input.existingBooking.businessId,
      projectedActiveServiceIds,
      input.cachedServices
    );
    const paidAmount = input.dto.paidAmount ?? input.existingBooking.paidAmount;
    if (paidAmount > totalAmount) {
      throw CustomError.badRequest("paidAmount no puede ser mayor al totalAmount");
    }
    const paymentStatus = this.resolvePaymentStatus(totalAmount, paidAmount);

    await this.ensureProjectedAppointmentsCanBeMarkedCreated(
      input.existingBooking.businessId,
      input.nextBranchId,
      projectedAppointments,
      {
        allowUnavailableBusiness:
          input.allowUnavailableBusinessForExistingAppointments,
      }
    );

    const bookingPayload: Record<string, unknown> = {
      appointments: normalizedAppointmentIds,
      totalAmount,
      paidAmount,
      paymentStatus,
      status: "CREATED",
      updatedAt: FirestoreDataBase.generateTimeStamp(),
      cancelledAt: FieldValue.delete(),
      deletedAt: FieldValue.delete(),
    };

    if (input.dto.branchId !== undefined) {
      bookingPayload.branchId = input.nextBranchId;
    }
    if (input.dto.clientId !== undefined) {
      bookingPayload.clientId = input.dto.clientId;
    }
    if (input.dto.paymentMethod !== undefined) {
      bookingPayload.paymentMethod = input.dto.paymentMethod;
    }

    const batchContext = this.firestoreConsistencyService.createBatchContext();
    for (const appointmentPlan of appointmentPlans) {
      if (appointmentPlan.payload == null) continue;
      batchContext.batch.update(
        batchContext.doc(APPOINTMENTS_COLLECTION, appointmentPlan.appointmentId),
        appointmentPlan.payload
      );
    }
    batchContext.batch.update(
      batchContext.doc(BOOKINGS_COLLECTION, input.existingBooking.id),
      bookingPayload
    );
    await batchContext.batch.commit();

    for (const appointmentPlan of appointmentPlans) {
      await this.runBookingPostCommitEffect(
        `aplicar side effects de la cita ${appointmentPlan.appointmentId}`,
        async () =>
          this.appointmentService.runPreparedBookingScopedAppointmentMutationEffects(
            appointmentPlan
          )
      );
    }

    await this.runBookingPostCommitEffect(
      `sincronizar revenue del booking ${input.existingBooking.id}`,
      async () =>
        this.appointmentService.syncBookingRevenueMetricsFromSnapshot(
          input.existingBooking.id,
          input.beforeRevenueSnapshot
        )
    );

    return await this.getBookingById(input.existingBooking.id);
  }

  private async updateBookingWithProjectedStagedOperations(
    id: string,
    dto: UpdateBookingDto,
    opts?: UpdateBookingOptions
  ): Promise<Booking> {
    const operations = dto.operations ?? [];
    if (operations.length === 0) {
      return await this.updateBookingInternal(id, dto, opts);
    }

    const stageDtos = this.buildProjectedOperationStageDtos(dto);
    let latestBooking: Booking | null = null;

    for (const stageDto of stageDtos) {
      latestBooking = await this.updateBookingInternal(id, stageDto, opts);
    }

    if (latestBooking != null) {
      return latestBooking;
    }

    return await this.getBookingById(id);
  }

  private async updateBookingWithProjectedAddOperations(input: {
    existingBooking: Booking;
    dto: UpdateBookingDto;
    nextBranchId: string;
    nextBranchForValidation: Branch | null;
    cachedServices: Service[] | undefined;
    beforeRevenueSnapshot: Awaited<
      ReturnType<AppointmentService["captureBookingRevenueSnapshot"]>
    >;
    allowUnavailableBusinessForExistingAppointments: boolean;
  }): Promise<Booking> {
    this.appointmentService.clearValidationCache();
    try {
      const addOperations = (input.dto.operations ?? []).filter(
        (
          operation
        ): operation is Extract<
          NonNullable<UpdateBookingDto["operations"]>[number],
          { op: "add" }
        > => operation.op === "add"
      );

      const validatedAddsResult =
        await this.appointmentService.validateDraftAppointmentsForNewBooking({
          businessId: input.existingBooking.businessId,
          branchId: input.nextBranchId,
          appointments: addOperations.map((operation) => ({
            date: operation.date,
            startTime: operation.startTime,
            endTime: operation.endTime,
            serviceId: operation.serviceId,
            employeeId: operation.employeeId,
          })),
        });

      const currentAppointments = await this.appointmentService.getAppointmentsByIds(
        input.existingBooking.appointments
      );

      if (
        input.nextBranchForValidation != null &&
        input.existingBooking.appointments.length > 0
      ) {
        await this.schedulingIntegrityService.ensureActiveAppointmentsRespectBranchSchedule(
          {
            appointmentIds: input.existingBooking.appointments,
            schedule: input.nextBranchForValidation.schedule,
            fallbackBookingId: input.existingBooking.id,
            errorMessagePrefix:
              "No se puede mover el agendamiento a la sede seleccionada porque hay citas activas fuera del horario de esa sede",
          }
        );
      }

      const batchContext = this.firestoreConsistencyService.createBatchContext();
      const createdAppointments = validatedAddsResult.appointments.map(
        (appointment) => {
          const appointmentRef = batchContext.doc(APPOINTMENTS_COLLECTION);
          batchContext.batch.set(appointmentRef, {
            id: appointmentRef.id,
            businessId: input.existingBooking.businessId,
            date: appointment.date,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
            serviceId: appointment.serviceId,
            employeeId: appointment.employeeId,
            status: "CREATED" as const,
            bookingId: input.existingBooking.id,
            createdAt: batchContext.now,
          });

          return {
            id: appointmentRef.id,
            businessId: input.existingBooking.businessId,
            date: appointment.date,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
            serviceId: appointment.serviceId,
            employeeId: appointment.employeeId,
            status: "CREATED" as const,
            bookingId: input.existingBooking.id,
            createdAt: batchContext.now.toDate().toISOString(),
          } satisfies Appointment;
        }
      );

      const projectedAppointments = [...currentAppointments, ...createdAppointments];
      await this.ensureProjectedAppointmentsCanBeMarkedCreated(
        input.existingBooking.businessId,
        input.nextBranchId,
        projectedAppointments,
        {
          allowUnavailableBusiness:
            input.allowUnavailableBusinessForExistingAppointments,
        }
      );

      const currentActiveServiceIds = currentAppointments
        .filter(
          (appointment) =>
            appointment.status !== "CANCELLED" && appointment.status !== "DELETED"
        )
        .map((appointment) => appointment.serviceId.trim())
        .filter((serviceId) => serviceId !== "");
      const totalAmount = await this.calculateTotalPriceFromServiceIds(
        input.existingBooking.businessId,
        [
          ...currentActiveServiceIds,
          ...validatedAddsResult.appointments.map((appointment) => appointment.serviceId),
        ],
        input.cachedServices
      );
      const paidAmount = input.dto.paidAmount ?? input.existingBooking.paidAmount;
      if (paidAmount > totalAmount) {
        throw CustomError.badRequest("paidAmount no puede ser mayor al totalAmount");
      }
      const paymentStatus = this.resolvePaymentStatus(totalAmount, paidAmount);
      const bookingPayload: Record<string, unknown> = {
        appointments: [
          ...input.existingBooking.appointments,
          ...createdAppointments.map((appointment) => appointment.id),
        ],
        totalAmount,
        paidAmount,
        paymentStatus,
        status: "CREATED",
        updatedAt: batchContext.now,
        cancelledAt: FieldValue.delete(),
        deletedAt: FieldValue.delete(),
      };

      if (input.dto.branchId !== undefined) {
        bookingPayload.branchId = input.nextBranchId;
      }
      if (input.dto.clientId !== undefined) {
        bookingPayload.clientId = input.dto.clientId;
      }
      if (input.dto.paymentMethod !== undefined) {
        bookingPayload.paymentMethod = input.dto.paymentMethod;
      }

      batchContext.batch.update(
        batchContext.doc(BOOKINGS_COLLECTION, input.existingBooking.id),
        bookingPayload
      );
      await batchContext.batch.commit();

      await this.runBookingPostCommitEffect(
        `aplicar métricas de nuevas citas para booking ${input.existingBooking.id}`,
        async () =>
          this.appointmentService.applyCreatedAppointmentsMetrics({
            businessId: input.existingBooking.businessId,
            branchId: input.nextBranchId,
            paymentStatus,
            appointments: validatedAddsResult.appointments.map((appointment) => ({
              date: appointment.date,
              employeeId: appointment.employeeId,
              servicePrice: appointment.servicePrice,
            })),
          })
      );

      for (const appointment of createdAppointments) {
        await this.runBookingPostCommitEffect(
          `programar tasks automáticas de la cita ${appointment.id}`,
          async () => this.appointmentService.scheduleCreatedAppointmentTasks(appointment)
        );
      }

      await this.runBookingPostCommitEffect(
        `sincronizar revenue del booking ${input.existingBooking.id}`,
        async () =>
          this.appointmentService.syncBookingRevenueMetricsFromSnapshot(
            input.existingBooking.id,
            input.beforeRevenueSnapshot
          )
      );

      return await this.getBookingById(input.existingBooking.id);
    } finally {
      this.appointmentService.clearValidationCache();
    }
  }

  private async updateBookingWithProjectedStatusOnlyFlow(input: {
    existingBooking: Booking;
    nextStatus: BookingStatus;
    beforeRevenueSnapshot: Awaited<
      ReturnType<AppointmentService["captureBookingRevenueSnapshot"]>
    >;
    allowUnavailableBusinessForExistingAppointments: boolean;
  }): Promise<Booking> {
    const normalizedAppointmentIds = Array.from(
      new Set(input.existingBooking.appointments)
    );
    await this.ensureBookingStatusTransitionAllowed(
      input.existingBooking.status,
      input.nextStatus,
      normalizedAppointmentIds
    );

    const currentAppointments = await this.appointmentService.getAppointmentsByIds(
      normalizedAppointmentIds
    );
    const projectedAppointmentsById = new Map(
      currentAppointments.map((appointment) => [appointment.id, appointment] as const)
    );
    const appointmentPlans: PreparedBookingScopedAppointmentMutation[] = [];

    for (const appointmentId of normalizedAppointmentIds) {
      const plan =
        await this.appointmentService.prepareSetAppointmentStatusForBookingMutation(
          appointmentId,
          input.nextStatus,
          {
            allowUnavailableBusiness:
              input.allowUnavailableBusinessForExistingAppointments,
          }
        );
      projectedAppointmentsById.set(plan.projectedAppointment.id, plan.projectedAppointment);
      appointmentPlans.push(plan);
    }

    const projectedAppointments = currentAppointments.map(
      (appointment) => projectedAppointmentsById.get(appointment.id) ?? appointment
    );

    if (input.nextStatus === "CREATED") {
      await this.ensureProjectedAppointmentsCanBeMarkedCreated(
        input.existingBooking.businessId,
        input.existingBooking.branchId,
        projectedAppointments,
        {
          allowUnavailableBusiness:
            input.allowUnavailableBusinessForExistingAppointments,
        }
      );
    }

    const activeServiceIdsForTotals =
      input.nextStatus === "CREATED"
        ? projectedAppointments
            .filter(
              (appointment) =>
                appointment.status !== "CANCELLED" && appointment.status !== "DELETED"
            )
            .map((appointment) => appointment.serviceId.trim())
            .filter((serviceId) => serviceId !== "")
        : currentAppointments
            .filter(
              (appointment) =>
                appointment.status !== "CANCELLED" && appointment.status !== "DELETED"
            )
            .map((appointment) => appointment.serviceId.trim())
            .filter((serviceId) => serviceId !== "");

    let totalAmount = input.existingBooking.totalAmount;
    let paidAmount = input.existingBooking.paidAmount;
    let paymentStatus = input.existingBooking.paymentStatus;
    if (input.nextStatus !== "DELETED") {
      totalAmount = await this.calculateTotalPriceFromServiceIds(
        input.existingBooking.businessId,
        activeServiceIdsForTotals,
        undefined,
        { includeDeletedServices: input.nextStatus === "FINISHED" }
      );
      if (paidAmount > totalAmount) {
        throw CustomError.badRequest("paidAmount no puede ser mayor al totalAmount");
      }
      paymentStatus = this.resolvePaymentStatus(totalAmount, paidAmount);
    }

    const cancellationNotificationAppointments =
      input.nextStatus === "CANCELLED" &&
      input.existingBooking.status !== "CANCELLED"
        ? currentAppointments.filter((appointment) => appointment.status !== "DELETED")
        : [];

    const batchContext = this.firestoreConsistencyService.createBatchContext();
    for (const appointmentPlan of appointmentPlans) {
      if (appointmentPlan.payload == null) continue;
      batchContext.batch.update(
        batchContext.doc(APPOINTMENTS_COLLECTION, appointmentPlan.appointmentId),
        appointmentPlan.payload
      );
    }

    const bookingPayload: Record<string, unknown> = {
      appointments: normalizedAppointmentIds,
      totalAmount,
      paidAmount,
      paymentStatus,
      status: input.nextStatus,
      updatedAt: batchContext.now,
    };
    if (input.nextStatus === "CANCELLED") {
      bookingPayload.cancelledAt = batchContext.now;
      bookingPayload.deletedAt = FieldValue.delete();
    } else if (input.nextStatus === "DELETED") {
      bookingPayload.deletedAt = batchContext.now;
      bookingPayload.cancelledAt = FieldValue.delete();
    } else {
      bookingPayload.cancelledAt = FieldValue.delete();
      bookingPayload.deletedAt = FieldValue.delete();
    }

    batchContext.batch.update(
      batchContext.doc(BOOKINGS_COLLECTION, input.existingBooking.id),
      bookingPayload
    );
    await batchContext.batch.commit();

    if (input.nextStatus === "DELETED") {
      await this.runBookingPostCommitEffect(
        `eliminar reviews del booking ${input.existingBooking.id}`,
        async () =>
          this.reviewService.deleteReviewsByAppointmentIds(normalizedAppointmentIds)
      );
    }

    for (const appointmentPlan of appointmentPlans) {
      await this.runBookingPostCommitEffect(
        `aplicar side effects de la cita ${appointmentPlan.appointmentId}`,
        async () =>
          this.appointmentService.runPreparedBookingScopedAppointmentMutationEffects(
            appointmentPlan
          )
      );
    }

    await this.runBookingPostCommitEffect(
      `sincronizar revenue del booking ${input.existingBooking.id}`,
      async () =>
        this.appointmentService.syncBookingRevenueMetricsFromSnapshot(
          input.existingBooking.id,
          input.beforeRevenueSnapshot
        )
    );

    if (
      input.nextStatus === "DELETED" &&
      input.existingBooking.status !== "DELETED"
    ) {
      await this.runBookingPostCommitEffect(
        `liberar cupo de booking del negocio ${input.existingBooking.businessId}`,
        async () =>
          this.businessUsageLimitService.release(
            input.existingBooking.businessId,
            "bookings",
            1
          )
      );
    }

    if (
      (input.nextStatus === "CANCELLED" || input.nextStatus === "DELETED") &&
      input.existingBooking.status !== input.nextStatus &&
      input.existingBooking.status !== "FINISHED" &&
      !(input.nextStatus === "DELETED" && input.existingBooking.status === "CANCELLED")
    ) {
      await this.sendBookingStatusChangedWhatsApp(
        input.existingBooking.businessId,
        input.existingBooking.clientId,
        input.existingBooking.consecutive
      ).catch((whatsAppError) => {
        const detail =
          whatsAppError instanceof Error
            ? whatsAppError.message
            : typeof whatsAppError === "string"
              ? whatsAppError
              : JSON.stringify(whatsAppError);

        logger.warn(
          `[BookingService] No se pudo enviar WhatsApp de ${input.nextStatus} para booking ${input.existingBooking.id}. detalle=${detail}`
        );
      });
    }

    if (
      input.nextStatus === "FINISHED" &&
      input.existingBooking.status !== "FINISHED"
    ) {
      await this.sendBookingFinishedWhatsApp(
        input.existingBooking.id,
        input.existingBooking.businessId,
        input.existingBooking.clientId,
        input.existingBooking.consecutive
      ).catch((whatsAppError) => {
        const detail =
          whatsAppError instanceof Error
            ? whatsAppError.message
            : typeof whatsAppError === "string"
              ? whatsAppError
              : JSON.stringify(whatsAppError);

        logger.warn(
          `[BookingService] No se pudo enviar WhatsApp de FINISHED para booking ${input.existingBooking.id}. detalle=${detail}`
        );
      });
    }

    if (
      input.nextStatus === "CANCELLED" &&
      input.existingBooking.status !== "CANCELLED"
    ) {
      await this.pushNotificationService
        ?.notifyBookingCancelled({
          businessId: input.existingBooking.businessId,
          branchId: input.existingBooking.branchId,
          bookingId: input.existingBooking.id,
          bookingConsecutive: input.existingBooking.consecutive,
          clientDocument: input.existingBooking.clientId,
          employeeIds: cancellationNotificationAppointments.map(
            (appointment) => appointment.employeeId
          ),
          appointments: cancellationNotificationAppointments.map((appointment) => ({
            id: appointment.id,
            date: appointment.date,
            startTime: appointment.startTime,
          })),
        })
        .catch((pushNotificationError) => {
          const detail =
            pushNotificationError instanceof Error
              ? pushNotificationError.message
              : typeof pushNotificationError === "string"
                ? pushNotificationError
                : JSON.stringify(pushNotificationError);

          logger.warn(
            `[BookingService] No se pudo enviar notificación push de cancelación para booking ${input.existingBooking.id}. detalle=${detail}`
          );
        });
    }

    return await this.getBookingById(input.existingBooking.id);
  }

  private ensureBookingAppointmentsNotInPast(
    appointments: CreateBookingAppointmentDto[]
  ): void {
    appointments.forEach((appointment) => {
      this.appointmentService.ensureAppointmentDateTimeIsNotPast(
        appointment.date,
        appointment.startTime
      );
    });
  }

  private ensureBookingOperationsNotInPast(dto: UpdateBookingDto): void {
    (dto.operations ?? []).forEach((operation) => {
      if (operation.op === "cancel") return;
      this.appointmentService.ensureAppointmentDateTimeIsNotPast(
        operation.date,
        operation.startTime
      );
    });
  }

  private async ensureServicesEditableForBookingUpdate(
    businessId: string,
    dto: UpdateBookingDto
  ): Promise<Service[]> {
    const services = await FirestoreService.getAll<Service>(SERVICES_COLLECTION, [
      { field: "businessId", operator: "==", value: businessId },
    ]);

    const requestedServiceIds = (dto.operations ?? [])
      .filter((operation) => operation.op !== "cancel")
      .map((operation) => operation.serviceId.trim())
      .filter((serviceId) => serviceId !== "");

    if (requestedServiceIds.length === 0) return services;

    const requestedUniqueServiceIds = Array.from(new Set(requestedServiceIds));
    const servicesById = new Map(
      services.map((service) => [service.id.trim(), service] as const)
    );

    const deletedServiceIds: string[] = [];
    const missingServiceIds: string[] = [];
    for (const serviceId of requestedUniqueServiceIds) {
      const service = servicesById.get(serviceId);
      if (service == null) {
        missingServiceIds.push(serviceId);
        continue;
      }
      if (service.status === "DELETED") {
        deletedServiceIds.push(serviceId);
      }
    }

    if (deletedServiceIds.length > 0) {
      throw CustomError.badRequest(
        `No se puede editar el agendamiento porque estos servicios están eliminados: ${deletedServiceIds.join(", ")}`
      );
    }

    if (missingServiceIds.length > 0) {
      throw CustomError.badRequest(
        `Los siguientes servicios no existen en el negocio: ${missingServiceIds.join(", ")}`
      );
    }

    return services;
  }

  private async calculateTotalPriceFromServiceIds(
    businessId: string,
    serviceIds: string[],
    cachedServices?: Service[],
    opts?: { includeDeletedServices?: boolean }
  ): Promise<number> {
    const requestedServiceIds = serviceIds.map((serviceId) => serviceId.trim());
    const requestedUniqueServiceIds = Array.from(
      new Set(requestedServiceIds.filter((serviceId) => serviceId !== ""))
    );

    const services = cachedServices ??
      await FirestoreService.getAll<Service>(SERVICES_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]);
    const servicesById = new Map(
      services
        .filter(
          (service) =>
            opts?.includeDeletedServices === true || service.status !== "DELETED"
        )
        .map((service) => [service.id.trim(), service] as const)
    );

    const invalidServiceIds = requestedUniqueServiceIds.filter(
      (serviceId) => !servicesById.has(serviceId)
    );
    if (invalidServiceIds.length > 0) {
      throw CustomError.badRequest(
        `Los siguientes servicios no existen en el negocio: ${invalidServiceIds.join(", ")}`
      );
    }

    return requestedServiceIds.reduce((total, serviceId) => {
      const service = servicesById.get(serviceId);
      return total + (service?.price ?? 0);
    }, 0);
  }

  private async ensureAppointmentBelongsToBooking(
    bookingId: string,
    appointmentId: string
  ): Promise<{ id: string; status: string }> {
    const appointment = await this.appointmentService.getAppointmentById(appointmentId);
    if (appointment.bookingId !== bookingId) {
      throw CustomError.badRequest(
        `La cita ${appointmentId} no pertenece al booking ${bookingId}`
      );
    }

    return {
      id: appointment.id,
      status: appointment.status,
    };
  }

  private async applyStatusToAppointments(
    status: BookingStatus,
    appointmentIds: string[]
  ): Promise<void> {
    if (appointmentIds.length === 0) return;

    const appointments = await this.appointmentService.getAppointmentsByIds(appointmentIds);
    const appointmentsById = new Map(
      appointments.map((appointment) => [appointment.id, appointment])
    );

    for (const appointmentId of appointmentIds) {
      const appointment = appointmentsById.get(appointmentId);
      if (!appointment) {
        continue;
      }
      if (appointment.status === "DELETED" && status !== "DELETED") {
        continue;
      }
      if (
        appointment.status === "FINISHED" &&
        status !== "DELETED" &&
        status !== "FINISHED"
      ) {
        throw CustomError.badRequest(
          `No se puede cambiar el estado de la cita ${appointmentId} porque está finalizada`
        );
      }
      if (
        status === "CREATED" &&
        appointment.status !== "CREATED" &&
        appointment.status !== "CANCELLED"
      ) {
        throw CustomError.badRequest(
          `Solo se puede marcar como creada la cita ${appointmentId} si está cancelada`
        );
      }

      if (status === "CANCELLED") {
        await this.appointmentService.cancelAppointment(appointmentId, {
          skipBookingSync: true,
        });
        continue;
      }

      if (status === "DELETED") {
        await this.appointmentService.deleteAppointment(appointmentId, {
          skipBookingSync: true,
        });
        continue;
      }

      await this.appointmentService.setAppointmentStatus(appointmentId, status, {
        skipBookingSync: true,
      });
    }
  }

  private async ensureBookingCanBeMarkedCreated(
    businessId: string,
    branchId: string,
    appointmentIds: string[],
    opts?: { allowUnavailableBusiness?: boolean }
  ): Promise<void> {
    await this.appointmentService.ensureBusinessAndBranch(
      businessId,
      branchId,
      opts?.allowUnavailableBusiness === true
        ? { allowUnavailableBusiness: true }
        : undefined
    );
    if (appointmentIds.length === 0) return;

    const appointments = await this.appointmentService.getAppointmentsByIds(appointmentIds);
    for (const appointment of appointments) {
      if (appointment.status === "DELETED") continue;

      await this.appointmentService.ensureServiceExistsInBusiness(
        appointment.serviceId,
        businessId
      );
      await this.appointmentService.ensureEmployeeIsActiveInBusiness(
        appointment.employeeId,
        businessId
      );
    }
  }

  private async ensureProjectedAppointmentsCanBeMarkedCreated(
    businessId: string,
    branchId: string,
    appointments: Appointment[],
    opts?: { allowUnavailableBusiness?: boolean }
  ): Promise<void> {
    await this.appointmentService.ensureBusinessAndBranch(
      businessId,
      branchId,
      opts?.allowUnavailableBusiness === true
        ? { allowUnavailableBusiness: true }
        : undefined
    );

    for (const appointment of appointments) {
      if (appointment.status === "DELETED") continue;

      await this.appointmentService.ensureServiceExistsInBusiness(
        appointment.serviceId,
        businessId
      );
      await this.appointmentService.ensureEmployeeIsActiveInBusiness(
        appointment.employeeId,
        businessId
      );
    }
  }

  private normalizeUpdateBookingDtoForEditProjection(
    dto: UpdateBookingDto,
    hasBookingEditChanges: boolean
  ): UpdateBookingDto {
    if (!hasBookingEditChanges || dto.status === undefined) {
      return dto;
    }

    const { status: _ignoredStatus, ...rest } = dto;
    return rest;
  }

  private async runBookingPostCommitEffect(
    description: string,
    action: () => Promise<void>
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      logger.warn(
        `[BookingService] No se pudo ${description}. detalle=${detail}`
      );
    }
  }

  private async ensureBookingStatusTransitionAllowed(
    currentStatus: BookingStatus,
    nextStatus: BookingStatus,
    appointmentIds: string[]
  ): Promise<void> {
    if (currentStatus === "DELETED" && nextStatus !== "DELETED") {
      throw CustomError.badRequest(
        "No se puede cambiar el estado de un agendamiento eliminado"
      );
    }

    if (nextStatus === "DELETED") {
      return;
    }

    if (nextStatus === "CREATED" && currentStatus === "FINISHED") {
      throw CustomError.badRequest(
        "No se puede marcar como creado un agendamiento finalizado"
      );
    }

    if (nextStatus === "CANCELLED") {
      const appointments = await this.appointmentService.getAppointmentsByIds(appointmentIds);
      const hasFinishedAppointment = appointments.some(
        (appointment) => appointment.status === "FINISHED"
      );
      if (hasFinishedAppointment) {
        throw CustomError.badRequest(
          "No se puede marcar como cancelado un agendamiento con citas finalizadas"
        );
      }
    }
  }

  private async getBookingById(id: string): Promise<Booking> {
    const booking = await FirestoreService.getById<Booking>(BOOKINGS_COLLECTION, id);
    return this.normalizeBooking(booking);
  }

  private normalizeBooking(booking: Booking): Booking {
    const appointments = Array.from(
      new Set(
        (booking.appointments ?? [])
          .map((appointmentId) => appointmentId.trim())
          .filter((appointmentId) => appointmentId !== "")
      )
    );

    const legacyBooking = booking as Booking & { totalPrice?: number };
    const totalAmount =
      Number.isFinite(booking.totalAmount) && booking.totalAmount >= 0
        ? booking.totalAmount
        : Number.isFinite(legacyBooking.totalPrice) && (legacyBooking.totalPrice ?? 0) >= 0
          ? (legacyBooking.totalPrice as number)
          : 0;
    const paidAmount =
      Number.isFinite(booking.paidAmount) && booking.paidAmount >= 0
        ? booking.paidAmount
        : 0;

    return {
      ...booking,
      consecutive: normalizeBookingConsecutive(booking.consecutive),
      appointments,
      totalAmount,
      paidAmount,
      paymentMethod: this.normalizePaymentMethod(booking.paymentMethod),
      paymentStatus: this.resolvePaymentStatus(totalAmount, paidAmount),
    };
  }

  private normalizePaymentMethod(
    paymentMethod?: BookingPaymentMethod
  ): BookingPaymentMethod {
    if (paymentMethod == null) return "CASH";
    return paymentMethod;
  }

  private resolvePaymentStatus(
    totalAmount: number,
    paidAmount: number
  ): BookingPaymentStatus {
    if (totalAmount <= 0 || paidAmount <= 0) {
      return "PENDING";
    }
    if (paidAmount >= totalAmount) {
      return "PAID";
    }
    return "PARTIALLY_PAID";
  }
}
