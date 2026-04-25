import { CloudTasksClient, protos } from "@google-cloud/tasks";
import { CustomError } from "../../domain/errors/custom-error";
import { logger } from "../logger/logger";
import type {
  CreateHttpTaskInput,
  CreateHttpTaskResult,
  QueueHttpMethod,
  TaskQueueProvider,
} from "../../domain/interfaces/task-queue.interface";

export interface GoogleCloudTasksConfig {
  projectId: string;
  location: string;
  queue: string;
  maxAttempts: number;
}

export class GoogleCloudTasksQueueProvider implements TaskQueueProvider {
  private readonly client: CloudTasksClient;
  private queueRetryConfigSyncPromise: Promise<void> | undefined;

  constructor(
    private readonly config: GoogleCloudTasksConfig,
    client?: CloudTasksClient
  ) {
    this.client = client ?? new CloudTasksClient();
  }

  async createHttpTask(input: CreateHttpTaskInput): Promise<CreateHttpTaskResult> {
    this.ensureConfigured();

    const projectId = this.config.projectId.trim();
    const location = this.config.location.trim();
    const queue = this.config.queue.trim();

    const parent = this.client.queuePath(projectId, location, queue);
    await this.ensureQueueRetryConfig(parent);
    const taskNameForRequest = this.resolveTaskName(projectId, location, queue, input.taskId);
    const task = this.buildTask(input, taskNameForRequest);

    try {
      const [response] = await this.client.createTask({
        parent,
        task,
      });

      const taskName = response.name?.trim() ?? "";
      if (taskName === "") {
        throw CustomError.internalServerError(
          "No se pudo programar la tarea automática"
        );
      }

      return {
        taskName,
        ...(this.toIsoString(response.scheduleTime) != null && {
          scheduleTime: this.toIsoString(response.scheduleTime)!,
        }),
      };
    } catch (error) {
      if (this.isAlreadyExistsError(error) && taskNameForRequest != null) {
        return { taskName: taskNameForRequest };
      }

      if (error instanceof CustomError) throw error;

      const details =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);

      logger.error(
        `[GoogleCloudTasksQueueProvider] No se pudo crear la tarea. detalle=${details}`
      );
      throw CustomError.internalServerError(
        "No se pudo programar la tarea automática"
      );
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    this.ensureConfigured();

    const projectId = this.config.projectId.trim();
    const location = this.config.location.trim();
    const queue = this.config.queue.trim();
    const taskName = this.resolveTaskName(projectId, location, queue, taskId);

    if (taskName == null) {
      throw CustomError.badRequest("No se puede eliminar una tarea sin identificador");
    }

    try {
      await this.client.deleteTask({ name: taskName });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return;
      }

      if (error instanceof CustomError) throw error;

      const details =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);

      logger.error(
        `[GoogleCloudTasksQueueProvider] No se pudo eliminar la tarea. detalle=${details}`
      );
      throw CustomError.internalServerError(
        "No se pudo eliminar la tarea automática"
      );
    }
  }

  private async ensureQueueRetryConfig(queuePath: string): Promise<void> {
    if (this.queueRetryConfigSyncPromise == null) {
      this.queueRetryConfigSyncPromise = this.syncQueueRetryConfig(queuePath).catch((error) => {
        this.queueRetryConfigSyncPromise = undefined;
        throw error;
      });
    }

    try {
      await this.queueRetryConfigSyncPromise;
    } catch (error) {
      const details =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);

      logger.warn(
        `[GoogleCloudTasksQueueProvider] No se pudo sincronizar retryConfig de la cola ${queuePath}. detalle=${details}`
      );
    }
  }

  private async syncQueueRetryConfig(queuePath: string): Promise<void> {
    const maxAttempts = this.normalizeMaxAttempts();
    const [queue] = await this.client.getQueue({ name: queuePath });
    const currentMaxAttempts = Number(queue.retryConfig?.maxAttempts ?? 0);

    if (currentMaxAttempts === maxAttempts) return;

    await this.client.updateQueue({
      queue: {
        name: queuePath,
        retryConfig: {
          ...(queue.retryConfig ?? {}),
          maxAttempts,
        },
      },
      updateMask: {
        paths: ["retry_config.max_attempts"],
      },
    });

    logger.info(
      `[GoogleCloudTasksQueueProvider] retryConfig sincronizado. queue=${queuePath}, maxAttempts=${maxAttempts}`
    );
  }

  private buildTask(
    input: CreateHttpTaskInput,
    taskNameForRequest?: string
  ): protos.google.cloud.tasks.v2.ITask {
    const url = input.url.trim();
    if (url === "") {
      throw CustomError.internalServerError(
        "No se puede crear una task sin URL destino"
      );
    }

    const method = input.method ?? "POST";
    const headers = {
      ...(input.headers ?? {}),
    };

    const hasBody = input.body !== undefined;
    const bodyBuffer = hasBody ? Buffer.from(JSON.stringify(input.body)) : undefined;

    if (hasBody && headers["Content-Type"] == null && headers["content-type"] == null) {
      headers["Content-Type"] = "application/json";
    }

    const task: protos.google.cloud.tasks.v2.ITask = {
      ...(taskNameForRequest != null && { name: taskNameForRequest }),
      httpRequest: {
        httpMethod: this.resolveHttpMethod(method),
        url,
        headers,
        ...(bodyBuffer != null && { body: bodyBuffer }),
      },
    };

    if (
      input.scheduleDelaySeconds != null &&
      Number.isFinite(input.scheduleDelaySeconds) &&
      input.scheduleDelaySeconds > 0
    ) {
      const delaySeconds = Math.floor(input.scheduleDelaySeconds);
      const scheduleEpochSeconds = Math.floor(Date.now() / 1000) + delaySeconds;
      task.scheduleTime = {
        seconds: scheduleEpochSeconds,
        nanos: 0,
      };
    }

    return task;
  }

  private normalizeMaxAttempts(): number {
    if (
      Number.isFinite(this.config.maxAttempts) &&
      Math.floor(this.config.maxAttempts) >= 1
    ) {
      return Math.floor(this.config.maxAttempts);
    }

    return 5;
  }

  private resolveTaskName(
    projectId: string,
    location: string,
    queue: string,
    taskId: string | undefined
  ): string | undefined {
    if (taskId == null || taskId.trim() === "") return undefined;

    const normalizedTaskId = taskId
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 500);

    if (normalizedTaskId === "") return undefined;

    return this.client.taskPath(projectId, location, queue, normalizedTaskId);
  }

  private isAlreadyExistsError(error: unknown): boolean {
    const code =
      typeof error === "object" &&
      error != null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : undefined;

    if (code === 6) return true;

    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";

    return message.toUpperCase().includes("ALREADY_EXISTS");
  }

  private isNotFoundError(error: unknown): boolean {
    const code =
      typeof error === "object" &&
      error != null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : undefined;

    if (code === 5) return true;

    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";

    return message.toUpperCase().includes("NOT_FOUND");
  }

  private resolveHttpMethod(
    method: QueueHttpMethod
  ): protos.google.cloud.tasks.v2.HttpMethod {
    switch (method) {
      case "POST":
        return protos.google.cloud.tasks.v2.HttpMethod.POST;
      case "PUT":
        return protos.google.cloud.tasks.v2.HttpMethod.PUT;
      case "PATCH":
        return protos.google.cloud.tasks.v2.HttpMethod.PATCH;
      case "DELETE":
        return protos.google.cloud.tasks.v2.HttpMethod.DELETE;
      default:
        return protos.google.cloud.tasks.v2.HttpMethod.POST;
    }
  }

  private toIsoString(
    scheduleTime: protos.google.protobuf.ITimestamp | null | undefined
  ): string | undefined {
    if (scheduleTime == null || scheduleTime.seconds == null) return undefined;

    const seconds = Number(scheduleTime.seconds);
    if (!Number.isFinite(seconds)) return undefined;

    const nanos = Number(scheduleTime.nanos ?? 0);
    const millis = seconds * 1000 + Math.floor(nanos / 1_000_000);
    return new Date(millis).toISOString();
  }

  private ensureConfigured(): void {
    const missing: string[] = [];

    if (this.isUnset(this.config.projectId)) missing.push("CLOUD_TASKS_PROJECT_ID");
    if (this.isUnset(this.config.location)) missing.push("CLOUD_TASKS_LOCATION");
    if (this.isUnset(this.config.queue)) missing.push("CLOUD_TASKS_QUEUE");
    if (!Number.isFinite(this.config.maxAttempts) || Math.floor(this.config.maxAttempts) < 1) {
      missing.push("CLOUD_TASKS_MAX_ATTEMPTS");
    }

    if (missing.length > 0) {
      logger.error(
        `[GoogleCloudTasksQueueProvider] Configuración incompleta. missing=${missing.join(", ")}`
      );
      throw CustomError.internalServerError(
        "Configuración incompleta para tareas automáticas"
      );
    }
  }

  private isUnset(value: string): boolean {
    const normalized = value.trim();
    return (
      normalized === "" ||
      normalized.toUpperCase().includes("REPLACE_ME") ||
      normalized.includes("<") ||
      normalized.includes(">")
    );
  }
}
