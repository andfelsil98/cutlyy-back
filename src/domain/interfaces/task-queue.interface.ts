export type QueueHttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface CreateHttpTaskInput {
  url: string;
  method?: QueueHttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  scheduleDelaySeconds?: number;
  taskId?: string;
}

export interface CreateHttpTaskResult {
  taskName: string;
  scheduleTime?: string;
}

export interface TaskQueueProvider {
  createHttpTask(input: CreateHttpTaskInput): Promise<CreateHttpTaskResult>;
  deleteTask(taskId: string): Promise<void>;
}
