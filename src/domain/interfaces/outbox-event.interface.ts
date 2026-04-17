export const OUTBOX_EVENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "DONE",
  "ERROR",
  "PAUSED",
] as const;

export type OutboxEventStatus = (typeof OUTBOX_EVENT_STATUSES)[number];

export const KNOWN_OUTBOX_EVENT_TYPES = [
  "BOOKING_CREATED",
  "BOOKING_METRICS_SYNC",
  "BOOKING_CREATED_WHATSAPP",
  "BOOKING_CREATED_PUSH",
  "BOOKING_CANCELLED",
  "BOOKING_FINISHED",
  "APPOINTMENT_TASKS_SYNC",
  "BUSINESS_DELETE_CASCADE",
  "BUSINESS_STORAGE_DELETE",
  "BRANCH_STORAGE_DELETE",
  "USER_AUTH_DELETE",
  "USER_AUTH_SYNC",
] as const;

export type KnownOutboxEventType = (typeof KNOWN_OUTBOX_EVENT_TYPES)[number];
export type OutboxEventType = KnownOutboxEventType | (string & {});

export const KNOWN_OUTBOX_AGGREGATE_TYPES = [
  "BOOKING",
  "APPOINTMENT",
  "BUSINESS",
  "BRANCH",
  "USER",
] as const;

export type KnownOutboxAggregateType = (typeof KNOWN_OUTBOX_AGGREGATE_TYPES)[number];
export type OutboxAggregateType = KnownOutboxAggregateType | (string & {});

export interface OutboxEventPayload {
  [key: string]: unknown;
}

export interface CreateOutboxEventInput<
  TPayload extends OutboxEventPayload = OutboxEventPayload,
> {
  type: OutboxEventType;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  payload: TPayload;
  status?: OutboxEventStatus;
  attempts?: number;
  lastError?: string;
  availableAt?: string;
}

export interface OutboxEvent<
  TPayload extends OutboxEventPayload = OutboxEventPayload,
> {
  id: string;
  type: OutboxEventType;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  status: OutboxEventStatus;
  payload: TPayload;
  attempts: number;
  lastError?: string;
  availableAt?: string;
  processedAt?: string;
  createdAt: string;
  updatedAt?: string;
}
