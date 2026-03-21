import type { WhatsAppMessageTaskType } from "../../config/whatsapp-message-types.config";
import type { Business } from "../../domain/interfaces/business.interface";
import type { Booking } from "../../domain/interfaces/booking.interface";
import { CustomError } from "../../domain/errors/custom-error";
import { logger } from "../../infrastructure/logger/logger";
import FirestoreService from "./firestore.service";
import { AppointmentService } from "./appointment.service";
import { UserService } from "./user.service";
import type { WhatsAppService } from "./whatsapp.service";

const BOOKINGS_COLLECTION = "Bookings";
const BUSINESSES_COLLECTION = "Businesses";

export interface HandleWhatsAppTaskInput {
  type: WhatsAppMessageTaskType;
  appointmentId: string;
}

export interface HandleWhatsAppTaskResult {
  type: WhatsAppMessageTaskType;
  appointmentId: string;
  changed: boolean;
  appointmentStatus: string;
  sentWhatsApp: boolean;
}

export class WhatsAppTaskService {
  constructor(
    private readonly appointmentService: AppointmentService,
    private readonly whatsAppService: WhatsAppService,
    private readonly userService: UserService = new UserService()
  ) {}

  async handleTask(input: HandleWhatsAppTaskInput): Promise<HandleWhatsAppTaskResult> {
    if (input.type === "appointment-status-in-progress") {
      const result = await this.appointmentService.markAppointmentInProgressIfDue(
        input.appointmentId
      );
      return {
        type: input.type,
        appointmentId: result.appointment.id,
        changed: result.changed,
        appointmentStatus: result.appointment.status,
        sentWhatsApp: false,
      };
    }

    if (input.type === "appointment-status-finished") {
      const result = await this.appointmentService.markAppointmentFinishedIfDue(
        input.appointmentId
      );
      let sentWhatsApp = false;
      if (result.changed && result.appointment.status === "FINISHED") {
        const booking = await this.getBookingById(result.appointment.bookingId);
        if (booking?.status === "FINISHED") {
          try {
            await this.sendBookingFinishedWhatsApp(booking);
            sentWhatsApp = true;
          } catch (error) {
            if (!this.isNonRetryableWhatsAppError(error)) {
              throw error;
            }

            logger.warn(
              `[WhatsAppTaskService] WhatsApp no recuperable para appointment ${result.appointment.id}. bookingId=${result.appointment.bookingId}, detalle=${error.message}`
            );
          }
        }
      }

      return {
        type: input.type,
        appointmentId: result.appointment.id,
        changed: result.changed,
        appointmentStatus: result.appointment.status,
        sentWhatsApp,
      };
    }

    throw CustomError.badRequest("type de WhatsApp no soportado");
  }

  private async resolveClientPhoneByBookingId(bookingId: string): Promise<string | null> {
    const sanitizedBookingId = bookingId.trim();
    if (sanitizedBookingId === "") return null;

    let booking: Booking;
    try {
      booking = await FirestoreService.getById<Booking>(
        BOOKINGS_COLLECTION,
        sanitizedBookingId
      );
    } catch (error) {
      if (error instanceof CustomError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }

    const clientDocument = booking.clientId?.trim() ?? "";
    if (clientDocument === "") return null;

    const user = await this.userService.getByDocument(clientDocument);
    const phone = user?.phone?.trim() ?? "";
    return phone !== "" ? phone : null;
  }

  private async getBookingById(bookingId: string): Promise<Booking | null> {
    const sanitizedBookingId = bookingId.trim();
    if (sanitizedBookingId === "") return null;

    try {
      return await FirestoreService.getById<Booking>(
        BOOKINGS_COLLECTION,
        sanitizedBookingId
      );
    } catch (error) {
      if (error instanceof CustomError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  private async sendBookingFinishedWhatsApp(booking: Booking): Promise<void> {
    const clientDocument = booking.clientId?.trim() ?? "";
    if (clientDocument === "") return;

    const [user, business] = await Promise.all([
      this.userService.getByDocument(clientDocument),
      FirestoreService.getById<Business>(BUSINESSES_COLLECTION, booking.businessId),
    ]);
    const phone = user?.phone?.trim() ?? "";
    if (phone === "") return;

    const businessName = business.name?.trim() || "Cutlyy";
    const clientName = user?.name?.trim() || "cliente";
    const consecutive = booking.consecutive?.trim() ?? "";
    if (consecutive === "") return;

    await this.whatsAppService.sendTemplateMessage({
      to: phone,
      templateType: "APPOINTMENT_COMPLETION",
      headerPlaceholders: [businessName],
      bodyPlaceholders: [clientName, consecutive],
      buttons: [
        {
          type: "URL",
          parameter: booking.id,
        },
      ],
    });

    logger.info(
      `[WhatsAppTaskService] WhatsApp de finalizacion aceptado por Infobip. bookingId=${booking.id}, to=${phone}, templateType=APPOINTMENT_COMPLETION`
    );
  }

  private isNonRetryableWhatsAppError(error: unknown): error is CustomError {
    return error instanceof CustomError && error.code === "INFOBIP_MESSAGE_REJECTED";
  }
}
