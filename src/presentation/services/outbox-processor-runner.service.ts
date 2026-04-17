import { logger } from "../../infrastructure/logger/logger";
import type { OutboxProcessorService } from "./outbox-processor.service";

export interface OutboxProcessorRunnerConfig {
  intervalMs?: number;
  initialDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_INITIAL_DELAY_MS = 1_000;

export class OutboxProcessorRunnerService {
  private intervalId?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private readonly outboxProcessorService: OutboxProcessorService,
    private readonly config?: OutboxProcessorRunnerConfig
  ) {}

  start(): void {
    if (this.intervalId != null) {
      return;
    }

    const intervalMs = this.normalizePositiveInt(
      this.config?.intervalMs,
      DEFAULT_INTERVAL_MS
    );
    const initialDelayMs = this.normalizePositiveInt(
      this.config?.initialDelayMs,
      DEFAULT_INITIAL_DELAY_MS
    );

    setTimeout(() => {
      void this.tick();
    }, initialDelayMs);

    this.intervalId = setInterval(() => {
      void this.tick();
    }, intervalMs);

    logger.info(
      `[OutboxProcessorRunnerService] Runner iniciado. intervalMs=${intervalMs}, initialDelayMs=${initialDelayMs}`
    );
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const result = await this.outboxProcessorService.processBatch();
      const processedCount = result.succeeded + result.failed + result.skipped;
      if (result.revivedStaleProcessing > 0 || processedCount > 0) {
        logger.info(
          `[OutboxProcessorRunnerService] Batch procesado. revived=${result.revivedStaleProcessing}, selected=${result.selected}, succeeded=${result.succeeded}, failed=${result.failed}, skipped=${result.skipped}`
        );
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.stack ?? error.message : String(error);
      logger.error(
        `[OutboxProcessorRunnerService] Falló la ejecución periódica del outbox. detalle=${detail}`
      );
    } finally {
      this.inFlight = false;
    }
  }

  private normalizePositiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || value == null || value <= 0) {
      return fallback;
    }
    return Math.floor(value);
  }
}
