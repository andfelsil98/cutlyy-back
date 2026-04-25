import {
  CLOUD_TASK_TOKEN_HEADER,
  WHATSAPP_SEND_MESSAGE_PATH,
} from "../../config/cloud-tasks.config";
import {
  WHATSAPP_MESSAGE_TASK_TYPES,
  type WhatsAppMessageTaskType,
} from "../../config/whatsapp-message-types.config";
import { CustomError } from "../../domain/errors/custom-error";
import type { TaskQueueProvider } from "../../domain/interfaces/task-queue.interface";
import { logger } from "../../infrastructure/logger/logger";

export interface ScheduleAppointmentStatusTasksInput {
  appointmentId: string;
  date: string;
  startTime: string;
  endTime: string;
}

export interface AppointmentStatusTaskScheduler {
  scheduleAppointmentStatusTasks(input: ScheduleAppointmentStatusTasksInput): Promise<void>;
  deleteAppointmentStatusTasks(input: { appointmentId: string }): Promise<void>;
}

export interface AppointmentStatusTaskSchedulerConfig {
  targetBaseUrl: string;
  internalToken: string;
}

export class AppointmentStatusTaskSchedulerService
  implements AppointmentStatusTaskScheduler
{
  constructor(
    private readonly taskQueueProvider: TaskQueueProvider,
    private readonly config: AppointmentStatusTaskSchedulerConfig
  ) {}

  async scheduleAppointmentStatusTasks(
    input: ScheduleAppointmentStatusTasksInput
  ): Promise<void> {
    const appointmentId = this.normalizeAppointmentId(input.appointmentId);

    const targetBaseUrl = this.config.targetBaseUrl.trim();
    if (targetBaseUrl === "") {
      throw CustomError.internalServerError(
        "Configuración incompleta para tareas automáticas"
      );
    }

    const internalToken = this.config.internalToken.trim();
    if (internalToken === "") {
      throw CustomError.internalServerError(
        "Configuración incompleta para tareas automáticas"
      );
    }

    await Promise.all([
      this.enqueueStatusTask(
        "appointment-status-in-progress",
        appointmentId,
        input.date,
        input.startTime,
        targetBaseUrl,
        internalToken
      ),
      this.enqueueStatusTask(
        "appointment-status-finished",
        appointmentId,
        input.date,
        input.endTime,
        targetBaseUrl,
        internalToken
      ),
    ]);
  }

  async deleteAppointmentStatusTasks(input: { appointmentId: string }): Promise<void> {
    const appointmentId = this.normalizeAppointmentId(input.appointmentId);

    await Promise.all(
      WHATSAPP_MESSAGE_TASK_TYPES.map((type) => this.deleteStatusTask(type, appointmentId))
    );
  }

  private async enqueueStatusTask(
    type: WhatsAppMessageTaskType,
    appointmentId: string,
    date: string,
    time: string,
    targetBaseUrl: string,
    internalToken: string
  ): Promise<void> {
    const delaySeconds = this.computeDelaySeconds(date, time);
    const taskId = this.buildTaskId(type, appointmentId);
    const url = this.buildTaskUrl(targetBaseUrl, type);

    const task = await this.taskQueueProvider.createHttpTask({
      taskId,
      url,
      method: "POST",
      scheduleDelaySeconds: delaySeconds,
      headers: {
        [CLOUD_TASK_TOKEN_HEADER]: internalToken,
      },
      body: {
        appointmentId,
      },
    });

    logger.info(
      `[AppointmentStatusTaskSchedulerService] Task programada. type=${type}, appointmentId=${appointmentId}, taskId=${taskId}, taskName=${task.taskName}, scheduleTime=${task.scheduleTime ?? "immediate"}, url=${url}`
    );
  }

  private async deleteStatusTask(
    type: WhatsAppMessageTaskType,
    appointmentId: string
  ): Promise<void> {
    const taskId = this.buildTaskId(type, appointmentId);

    await this.taskQueueProvider.deleteTask(taskId);

    logger.info(
      `[AppointmentStatusTaskSchedulerService] Task eliminada. type=${type}, appointmentId=${appointmentId}, taskId=${taskId}`
    );
  }

  private buildTaskUrl(targetBaseUrl: string, type: WhatsAppMessageTaskType): string {
    const normalizedBaseUrl = targetBaseUrl.trim().replace(/\/+$/, "");
    return `${normalizedBaseUrl}${WHATSAPP_SEND_MESSAGE_PATH}/${type}`;
  }

  private buildTaskId(type: WhatsAppMessageTaskType, appointmentId: string): string {
    return `appointment-${type}-${appointmentId}`;
  }

  private normalizeAppointmentId(appointmentId: string): string {
    const normalizedAppointmentId = appointmentId.trim();
    if (normalizedAppointmentId === "") {
      throw CustomError.badRequest("No se pueden gestionar tasks sin appointmentId");
    }

    return normalizedAppointmentId;
  }

  private computeDelaySeconds(date: string, time: string): number {
    const dateMatch = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = time.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!dateMatch || !timeMatch) {
      return 0;
    }

    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);

    // Interpretar la hora como Colombia (UTC-5, sin DST) y agregar 30s de gracia
    // para garantizar que el appointment esté persistido en Firestore antes de que
    // el task se ejecute.
    const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
    const TASK_EXECUTION_OFFSET_MS = 30 * 1000;
    const scheduledUtcMs =
      Date.UTC(year, month - 1, day, hours, minutes) +
      BOGOTA_OFFSET_MS +
      TASK_EXECUTION_OFFSET_MS;

    const delayMs = scheduledUtcMs - Date.now();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      return 0;
    }

    return Math.floor(delayMs / 1000);
  }
}
