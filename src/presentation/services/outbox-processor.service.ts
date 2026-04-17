import type { BookingPaymentStatus } from "../../domain/interfaces/booking.interface";
import type {
  OutboxEvent,
  OutboxEventPayload,
} from "../../domain/interfaces/outbox-event.interface";
import { CustomError } from "../../domain/errors/custom-error";
import { logger } from "../../infrastructure/logger/logger";
import type { AppointmentService, BookingRevenueSnapshot } from "./appointment.service";
import type { BusinessService } from "./business.service";
import type { BookingService } from "./booking.service";
import { ExternalDispatchAmbiguousError } from "./external-dispatch.service";
import { OutboxService } from "./outbox.service";

interface BookingMetricsSyncPayload {
  bookingId: string;
  businessId: string;
  branchId: string;
  paymentStatus: BookingPaymentStatus;
  beforeRevenueSnapshot?: BookingRevenueSnapshot | null;
  appointments: Array<{
    id: string;
    date: string;
    employeeId: string;
    servicePrice: number;
  }>;
}

interface AppointmentTasksSyncPayload {
  bookingId: string;
  appointments: Array<{
    id: string;
    date: string;
    startTime: string;
    endTime: string;
  }>;
}

interface BookingCreatedWhatsAppPayload {
  bookingId: string;
  businessId: string;
  clientDocument: string;
  bookingConsecutive: string;
}

interface BookingCreatedPushPayload {
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
}

interface BusinessDeleteCascadePayload extends OutboxEventPayload {
  businessId: string;
  actorDocument: string;
}

export interface OutboxProcessorConfig {
  batchSize?: number;
  processingTimeoutSeconds?: number;
  retryBaseDelaySeconds?: number;
  retryMaxDelaySeconds?: number;
}

export interface OutboxProcessBatchResult {
  revivedStaleProcessing: number;
  selected: number;
  succeeded: number;
  failed: number;
  skipped: number;
  processedEventIds: string[];
  failedEventIds: string[];
  skippedEventIds: string[];
}

type ProcessOutcome = "succeeded" | "failed" | "skipped";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_PROCESSING_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_RETRY_BASE_DELAY_SECONDS = 15;
const DEFAULT_RETRY_MAX_DELAY_SECONDS = 15 * 60;

export class OutboxProcessorService {
  private readonly batchSize: number;
  private readonly processingTimeoutSeconds: number;
  private readonly retryBaseDelaySeconds: number;
  private readonly retryMaxDelaySeconds: number;

  constructor(
    private readonly appointmentService: AppointmentService,
    private readonly bookingService: BookingService,
    private readonly businessService: BusinessService,
    private readonly outboxService: OutboxService = new OutboxService(),
    config?: OutboxProcessorConfig
  ) {
    this.batchSize = this.normalizePositiveInt(
      config?.batchSize,
      DEFAULT_BATCH_SIZE
    );
    this.processingTimeoutSeconds = this.normalizePositiveInt(
      config?.processingTimeoutSeconds,
      DEFAULT_PROCESSING_TIMEOUT_SECONDS
    );
    this.retryBaseDelaySeconds = this.normalizePositiveInt(
      config?.retryBaseDelaySeconds,
      DEFAULT_RETRY_BASE_DELAY_SECONDS
    );
    this.retryMaxDelaySeconds = this.normalizePositiveInt(
      config?.retryMaxDelaySeconds,
      DEFAULT_RETRY_MAX_DELAY_SECONDS
    );
  }

  async processBatch(limit = this.batchSize): Promise<OutboxProcessBatchResult> {
    const normalizedLimit = this.normalizePositiveInt(limit, this.batchSize);
    const revivedStaleProcessing = await this.reviveStaleProcessing(normalizedLimit);
    const events = await this.outboxService.getProcessable(normalizedLimit);

    const result: OutboxProcessBatchResult = {
      revivedStaleProcessing,
      selected: events.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      processedEventIds: [],
      failedEventIds: [],
      skippedEventIds: [],
    };

    for (const event of events) {
      const outcome = await this.processEvent(event);
      if (outcome === "succeeded") {
        result.succeeded += 1;
        result.processedEventIds.push(event.id);
        continue;
      }

      if (outcome === "skipped") {
        result.skipped += 1;
        result.skippedEventIds.push(event.id);
        continue;
      }

      result.failed += 1;
      result.failedEventIds.push(event.id);
    }

    return result;
  }

  private async reviveStaleProcessing(limit: number): Promise<number> {
    const staleEvents = await this.outboxService.getStaleProcessing(
      this.processingTimeoutSeconds,
      limit
    );

    for (const event of staleEvents) {
      await this.outboxService.requeue(event.id).catch((error) => {
        const detail = this.stringifyError(error);
        logger.warn(
          `[OutboxProcessorService] No se pudo reencolar el outbox stale ${event.id}. detalle=${detail}`
        );
      });
    }

    if (staleEvents.length > 0) {
      logger.warn(
        `[OutboxProcessorService] Se reencolaron ${staleEvents.length} eventos stale en PROCESSING`
      );
    }

    return staleEvents.length;
  }

  private async processEvent(event: OutboxEvent): Promise<ProcessOutcome> {
    const processingEvent = await this.outboxService.markProcessing(event.id).catch(
      (error) => {
        if (
          error instanceof CustomError &&
          (error.statusCode === 404 || error.statusCode === 409)
        ) {
          return null;
        }
        throw error;
      }
    );

    if (processingEvent == null) {
      return "skipped";
    }

    try {
      const outcome = await this.dispatch(processingEvent);
      await this.outboxService.markDone(processingEvent.id);
      return outcome;
    } catch (error) {
      if (error instanceof ExternalDispatchAmbiguousError) {
        const detail = this.stringifyError(error);

        logger.warn(
          `[OutboxProcessorService] El outbox ${processingEvent.id} quedó PAUSED por envío externo ambiguo. type=${processingEvent.type}, aggregateType=${processingEvent.aggregateType}, aggregateId=${processingEvent.aggregateId}, detalle=${detail}`
        );

        await this.outboxService
          .markPaused(processingEvent.id, detail)
          .catch((pauseFailure) => {
            const pauseDetail = this.stringifyError(pauseFailure);
            logger.warn(
              `[OutboxProcessorService] Además no se pudo marcar PAUSED el outbox ${processingEvent.id}. detalle=${pauseDetail}`
            );
          });

        return "skipped";
      }

      const detail = this.stringifyError(error);
      const retryAt = new Date(
        Date.now() + this.computeRetryDelaySeconds(processingEvent.attempts) * 1000
      );

      logger.warn(
        `[OutboxProcessorService] Falló el procesamiento del outbox ${processingEvent.id}. type=${processingEvent.type}, aggregateType=${processingEvent.aggregateType}, aggregateId=${processingEvent.aggregateId}, attempts=${processingEvent.attempts}, detalle=${detail}`
      );

      await this.outboxService
        .markError(processingEvent.id, detail, { availableAt: retryAt })
        .catch((markErrorFailure) => {
          const markErrorDetail = this.stringifyError(markErrorFailure);
          logger.warn(
            `[OutboxProcessorService] Además no se pudo marcar ERROR el outbox ${processingEvent.id}. detalle=${markErrorDetail}`
          );
        });

      return "failed";
    }
  }

  private async dispatch(event: OutboxEvent): Promise<Exclude<ProcessOutcome, "failed">> {
    switch (event.type) {
      case "BOOKING_METRICS_SYNC":
        await this.appointmentService.replayBookingMetricsSyncEvent(
          event.payload as unknown as BookingMetricsSyncPayload
        );
        return "succeeded";

      case "APPOINTMENT_TASKS_SYNC":
        await this.appointmentService.replayAppointmentTasksSyncEvent(
          event.payload as unknown as AppointmentTasksSyncPayload
        );
        return "succeeded";

      case "BOOKING_CREATED_WHATSAPP":
        await this.bookingService.replayBookingCreatedWhatsAppEvent(
          event.id,
          event.payload as unknown as BookingCreatedWhatsAppPayload
        );
        return "succeeded";

      case "BOOKING_CREATED_PUSH":
        await this.bookingService.replayBookingCreatedPushEvent(
          event.id,
          event.payload as unknown as BookingCreatedPushPayload
        );
        return "succeeded";

      case "BUSINESS_DELETE_CASCADE":
        await this.businessService.replayBusinessDeletionCascadeEvent(
          event.payload as unknown as BusinessDeleteCascadePayload
        );
        return "succeeded";

      default:
        throw CustomError.badRequest(
          `No existe un procesador registrado para el evento de outbox ${event.type}`
        );
    }
  }

  private computeRetryDelaySeconds(attempts: number): number {
    const normalizedAttempts = Math.max(1, Math.floor(attempts));
    const exponential = this.retryBaseDelaySeconds * 2 ** (normalizedAttempts - 1);
    return Math.min(this.retryMaxDelaySeconds, exponential);
  }

  private normalizePositiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || value == null || value <= 0) {
      return fallback;
    }
    return Math.floor(value);
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return JSON.stringify(error);
  }
}
