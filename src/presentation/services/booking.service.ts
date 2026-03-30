import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { FieldValue } from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import type { Appointment } from "../../domain/interfaces/appointment.interface";
import type {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from "../../domain/interfaces/booking.interface";
import { BOOKING_STATUSES } from "../../domain/interfaces/booking.interface";
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
import type { UpdateBookingDto } from "../booking/dtos/update-booking.dto";
import { BusinessUsageLimitService } from "./business-usage-limit.service";
import FirestoreService from "./firestore.service";
import { AppointmentService } from "./appointment.service";
import { ReviewService } from "./review.service";
import type { AppointmentStatusTaskScheduler } from "./appointment-status-task-scheduler.service";
import { logger } from "../../infrastructure/logger/logger";
import type { WhatsAppService } from "./whatsapp.service";
import { UserService } from "./user.service";
import { BookingConsecutiveService } from "./booking-consecutive.service";
import type { PushNotificationService } from "./push-notification.service";

const BOOKINGS_COLLECTION = "Bookings";
const BUSINESSES_COLLECTION = "Businesses";
const APPOINTMENTS_COLLECTION = "Appointments";
const SERVICES_COLLECTION = "Services";

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
      new BusinessUsageLimitService()
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
          "status debe ser CREATED, CANCELLED, FINISHED o DELETED"
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
    let createdBookingId: string | null = null;
    const createdAppointmentIds: string[] = [];
    const createdAppointments: Appointment[] = [];
    let bookingQuotaConsumed = false;

    try {
      if (dto.appointments.length === 0) {
        throw CustomError.badRequest(
          "Un booking debe incluir al menos un servicio/cita"
        );
      }
      this.ensureBookingAppointmentsNotInPast(dto.appointments);

      await this.appointmentService.ensureBusinessAndBranch(
        dto.businessId,
        dto.branchId
      );
      await this.appointmentService.ensureClientForBusiness(dto.businessId, {
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

      const business = await FirestoreService.getById<Business>(
        BUSINESSES_COLLECTION,
        dto.businessId
      );
      const totalPrice = await this.calculateTotalPrice(dto.businessId, dto.appointments);
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

      await this.businessUsageLimitService.consume(dto.businessId, "bookings", 1);
      bookingQuotaConsumed = true;

      const createdBooking = await FirestoreService.create<{
        businessId: string;
        branchId: string;
        consecutive: string;
        appointments: string[];
        clientId: string;
        status: "CREATED";
        totalAmount: number;
        paymentMethod: CreateBookingDto["paymentMethod"];
        paidAmount: number;
        paymentStatus: BookingPaymentStatus;
        createdAt: ReturnType<typeof FirestoreDataBase.generateTimeStamp>;
      }>(BOOKINGS_COLLECTION, {
        businessId: dto.businessId,
        branchId: dto.branchId,
        consecutive,
        appointments: [],
        clientId: dto.clientId,
        status: "CREATED",
        totalAmount: totalPrice,
        paymentMethod: dto.paymentMethod,
        paidAmount,
        paymentStatus,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });
      createdBookingId = createdBooking.id;

      this.appointmentService.clearValidationCache();
      for (const appointmentInput of dto.appointments) {
        const createdAppointment =
          await this.appointmentService.createAppointmentForBooking({
            bookingId: createdBooking.id,
            date: appointmentInput.date,
            startTime: appointmentInput.startTime,
            endTime: appointmentInput.endTime,
            serviceId: appointmentInput.serviceId,
            employeeId: appointmentInput.employeeId,
          });
        createdAppointmentIds.push(createdAppointment.id);
        createdAppointments.push(createdAppointment);
      }
      this.appointmentService.clearValidationCache();

      await FirestoreService.update(BOOKINGS_COLLECTION, createdBooking.id, {
        appointments: createdAppointmentIds,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      await this.appointmentService.syncBookingRevenueMetricsFromSnapshot(
        createdBooking.id,
        null
      );

      await this.scheduleStatusTasksForCreatedBookingAppointments(createdAppointments);

      await this.sendBookingCreatedWhatsApp(
        createdBooking.id,
        dto.businessId,
        consecutive,
        dto.clientId,
        { cachedBusiness: business }
      ).catch((whatsAppError) => {
        const detail =
          whatsAppError instanceof Error
            ? whatsAppError.message
            : typeof whatsAppError === "string"
              ? whatsAppError
              : JSON.stringify(whatsAppError);

        logger.warn(
          `[BookingService] No se pudo enviar WhatsApp de confirmación para booking ${createdBooking.id}. detalle=${detail}`
        );
      });

      await this.pushNotificationService
        ?.notifyBookingCreated({
          businessId: dto.businessId,
          branchId: dto.branchId,
          bookingId: createdBooking.id,
          bookingConsecutive: consecutive,
          clientDocument: dto.clientId,
          employeeIds: createdAppointments.map((appointment) => appointment.employeeId),
          appointments: createdAppointments.map((appointment) => ({
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
            `[BookingService] No se pudo enviar notificación push para booking ${createdBooking.id}. detalle=${detail}`
          );
        });

      const createdBookingDoc = await this.getBookingById(createdBooking.id);
      return createdBookingDoc;
    } catch (error) {
      await this.compensateFailedCreation(createdBookingId, createdAppointmentIds);
      if (bookingQuotaConsumed) {
        await this.businessUsageLimitService.release(dto.businessId, "bookings", 1).catch(
          () => undefined
        );
      }
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async addPayment(id: string, amount: number): Promise<Booking> {
    try {
      const booking = await this.getBookingById(id);
      const beforeRevenueSnapshot =
        await this.appointmentService.captureBookingRevenueSnapshot(id);

      if (booking.status === "DELETED" || booking.status === "CANCELLED") {
        throw CustomError.badRequest(
          "No se pueden registrar abonos en un agendamiento CANCELLED o DELETED"
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

  async updateBooking(id: string, dto: UpdateBookingDto): Promise<Booking> {
    try {
      const existingBooking = await this.getBookingById(id);
      const beforeRevenueSnapshot =
        await this.appointmentService.captureBookingRevenueSnapshot(id);
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

      if (
        hasBookingEditChanges &&
        (existingBooking.status === "DELETED" ||
          existingBooking.status === "CANCELLED" ||
          existingBooking.status === "FINISHED")
      ) {
        throw CustomError.badRequest(
          "No se puede editar un booking con estado FINISHED, DELETED o CANCELLED"
        );
      }

      const nextBranchId = dto.branchId ?? existingBooking.branchId;
      if (
        dto.branchId !== undefined &&
        dto.branchId.trim() !== existingBooking.branchId.trim()
      ) {
        await this.appointmentService.ensureBusinessAndBranch(
          existingBooking.businessId,
          nextBranchId
        );
      }

      if (dto.clientId !== undefined) {
        await this.appointmentService.ensureClientForBusiness(
          existingBooking.businessId,
          {
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
          }
        );
      }

      const isDeletingBooking = dto.status === "DELETED";
      let cachedServices: Service[] | undefined;
      if (!isDeletingBooking) {
        cachedServices = await this.ensureServicesEditableForBookingUpdate(
          existingBooking.businessId,
          dto
        );
      }
      this.ensureBookingOperationsNotInPast(dto);

      const appointmentIds = new Set(existingBooking.appointments);

      if (dto.operations != null) {
        for (const operation of dto.operations) {
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

      let totalAmount = existingBooking.totalAmount;
      let paidAmount = dto.paidAmount ?? existingBooking.paidAmount;
      let paymentStatus = existingBooking.paymentStatus;
      if (!isDeletingBooking) {
        totalAmount = await this.calculateTotalPriceFromAppointments(
          existingBooking.businessId,
          normalizedAppointmentIds,
          cachedServices,
          { includeDeletedServices: dto.status === "FINISHED" }
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
          normalizedAppointmentIds
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
      } else if (dto.status !== undefined) {
        await this.ensureBookingStatusTransitionAllowed(
          existingBooking.status,
          dto.status,
          normalizedAppointmentIds
        );
        if (dto.status === "DELETED") {
          await this.reviewService.deleteReviewsByAppointmentIds(
            normalizedAppointmentIds
          );
        }
        await this.applyStatusToAppointments(dto.status, normalizedAppointmentIds);
        payload.status = dto.status;

        if (dto.status === "CANCELLED") {
          payload.cancelledAt = FirestoreDataBase.generateTimeStamp();
          payload.deletedAt = FieldValue.delete();
        } else if (dto.status === "DELETED") {
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

      if (dto.status === "DELETED" && existingBooking.status !== "DELETED") {
        await this.businessUsageLimitService.release(
          existingBooking.businessId,
          "bookings",
          1
        );
      }

      if (
        !hasBookingEditChanges &&
        dto.status !== undefined &&
        (dto.status === "CANCELLED" || dto.status === "DELETED") &&
        existingBooking.status !== dto.status &&
        existingBooking.status !== "FINISHED" &&
        !(dto.status === "DELETED" && existingBooking.status === "CANCELLED")
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
            `[BookingService] No se pudo enviar WhatsApp de ${dto.status} para booking ${existingBooking.id}. detalle=${detail}`
          );
        });
      }

      if (
        !hasBookingEditChanges &&
        dto.status === "FINISHED" &&
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
          `Solo se puede marcar en CREATED la cita ${appointmentId} si está CANCELLED`
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
    appointmentIds: string[]
  ): Promise<void> {
    await this.appointmentService.ensureBusinessAndBranch(businessId, branchId);
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
        "No se puede marcar en CREATED un agendamiento finalizado"
      );
    }

    if (nextStatus === "CANCELLED") {
      const appointments = await this.appointmentService.getAppointmentsByIds(appointmentIds);
      const hasFinishedAppointment = appointments.some(
        (appointment) => appointment.status === "FINISHED"
      );
      if (hasFinishedAppointment) {
        throw CustomError.badRequest(
          "No se puede marcar en CANCELLED un agendamiento con citas finalizadas"
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
      paymentStatus: this.resolvePaymentStatus(totalAmount, paidAmount),
    };
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
