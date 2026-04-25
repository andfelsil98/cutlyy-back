import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type {
  CreateOutboxEventInput,
  OutboxEvent,
  OutboxEventPayload,
  OutboxEventStatus,
} from "../../domain/interfaces/outbox-event.interface";
import { OUTBOX_EVENT_STATUSES } from "../../domain/interfaces/outbox-event.interface";
import { logger } from "../../infrastructure/logger/logger";
import {
  FirestoreConsistencyService,
  type FirestoreBatchContext,
  type FirestoreTransactionContext,
} from "./firestore-consistency.service";

const COLLECTION_NAME = "OutboxEvents";
const DEFAULT_FETCH_LIMIT = 50;
const PROCESSABLE_OUTBOX_STATUSES: OutboxEventStatus[] = ["PENDING", "ERROR"];

type SupportedScheduleInput = string | Date | Timestamp;

type StoredOutboxEvent<TPayload extends OutboxEventPayload = OutboxEventPayload> = {
  type: string;
  aggregateType: string;
  aggregateId: string;
  status: OutboxEventStatus;
  payload: TPayload;
  attempts: number;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
  processedAt?: Timestamp;
  lastError?: string;
  availableAt?: Timestamp;
};

export interface ListOutboxEventsFilters {
  status?: OutboxEventStatus;
  type?: string;
  aggregateType?: string;
  aggregateId?: string;
  limit?: number;
}

interface InternalCreateOutboxEventInput<
  TPayload extends OutboxEventPayload = OutboxEventPayload,
> extends Omit<CreateOutboxEventInput<TPayload>, "availableAt"> {
  availableAt?: SupportedScheduleInput;
}

function isOutboxEventStatus(value: string): value is OutboxEventStatus {
  return OUTBOX_EVENT_STATUSES.includes(value as OutboxEventStatus);
}

function toOptionalISOString(value: Timestamp | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.toDate().toISOString();
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function mapStoredEvent<TPayload extends OutboxEventPayload>(
  id: string,
  stored: StoredOutboxEvent<TPayload>
): OutboxEvent<TPayload> {
  const response: OutboxEvent<TPayload> = {
    id,
    type: stored.type,
    aggregateType: stored.aggregateType,
    aggregateId: stored.aggregateId,
    status: stored.status,
    payload: stored.payload,
    attempts: Math.max(0, Number(stored.attempts ?? 0)),
    createdAt: stored.createdAt.toDate().toISOString(),
  };

  const updatedAt = toOptionalISOString(stored.updatedAt);
  if (updatedAt !== undefined) {
    response.updatedAt = updatedAt;
  }

  const processedAt = toOptionalISOString(stored.processedAt);
  if (processedAt !== undefined) {
    response.processedAt = processedAt;
  }

  const availableAt = toOptionalISOString(stored.availableAt);
  if (availableAt !== undefined) {
    response.availableAt = availableAt;
  }

  if (stored.lastError != null && stored.lastError.trim() !== "") {
    response.lastError = stored.lastError;
  }

  return response;
}

function parseOptionalSchedule(
  value: SupportedScheduleInput | undefined
): Timestamp | undefined {
  if (value == null) {
    return undefined;
  }

  if (value instanceof Timestamp) {
    return value;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw CustomError.badRequest("availableAt inválido para el evento de outbox");
    }
    return Timestamp.fromDate(value);
  }

  const normalizedValue = value.trim();
  if (normalizedValue === "") {
    return undefined;
  }

  const parsed = Date.parse(normalizedValue);
  if (Number.isNaN(parsed)) {
    throw CustomError.badRequest("availableAt inválido para el evento de outbox");
  }

  return Timestamp.fromDate(new Date(parsed));
}

function resolveProcessableAt(event: OutboxEvent): number {
  const source = event.availableAt ?? event.createdAt;
  const parsed = Date.parse(source);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
}

function toEventTimeMs(value: string | undefined): number {
  if (value == null || value.trim() === "") {
    return 0;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return 0;
  }

  return parsed;
}

export class OutboxService {
  constructor(
    private readonly firestoreConsistencyService: FirestoreConsistencyService =
      new FirestoreConsistencyService()
  ) {}

  getCollectionName(): string {
    return COLLECTION_NAME;
  }

  private handleUnexpectedError(operationName: string, error: unknown): never {
    if (error instanceof CustomError) throw error;
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    logger.error(`[OutboxService] ${operationName} failed. detalle=${detail}`);
    throw CustomError.internalServerError("Error interno del servidor");
  }

  private buildEventRecord<TPayload extends OutboxEventPayload>(
    input: InternalCreateOutboxEventInput<TPayload>,
    now: Timestamp
  ): {
    id: string;
    stored: StoredOutboxEvent<TPayload>;
    response: OutboxEvent<TPayload>;
  } {
    const type = input.type.trim();
    if (type === "") {
      throw CustomError.badRequest("type es requerido para el evento de outbox");
    }

    const aggregateType = input.aggregateType.trim();
    if (aggregateType === "") {
      throw CustomError.badRequest("aggregateType es requerido para el evento de outbox");
    }

    const aggregateId = input.aggregateId.trim();
    if (aggregateId === "") {
      throw CustomError.badRequest("aggregateId es requerido para el evento de outbox");
    }

    const status = input.status ?? "PENDING";
    if (!isOutboxEventStatus(status)) {
      throw CustomError.badRequest("status inválido para el evento de outbox");
    }

    const attempts =
      input.attempts != null ? Math.max(0, Math.floor(input.attempts)) : 0;
    const availableAt = parseOptionalSchedule(input.availableAt);
    const eventRef = this.firestoreConsistencyService.createDocumentReference(COLLECTION_NAME);

    const stored: StoredOutboxEvent<TPayload> = {
      type,
      aggregateType,
      aggregateId,
      status,
      payload: input.payload,
      attempts,
      createdAt: now,
      updatedAt: now,
    };

    if (availableAt !== undefined) {
      stored.availableAt = availableAt;
    }

    if (input.lastError != null && input.lastError.trim() !== "") {
      stored.lastError = input.lastError.trim();
    }

    if (status === "DONE") {
      stored.processedAt = now;
    }

    return {
      id: eventRef.id,
      stored,
      response: mapStoredEvent(eventRef.id, stored),
    };
  }

  enqueueInBatch<TPayload extends OutboxEventPayload>(
    context: FirestoreBatchContext,
    input: InternalCreateOutboxEventInput<TPayload>
  ): OutboxEvent<TPayload> {
    const prepared = this.buildEventRecord(input, context.now);
    context.batch.set(context.doc(COLLECTION_NAME, prepared.id), {
      id: prepared.id,
      ...prepared.stored,
    });
    return prepared.response;
  }

  enqueueInTransaction<TPayload extends OutboxEventPayload>(
    context: FirestoreTransactionContext,
    input: InternalCreateOutboxEventInput<TPayload>
  ): OutboxEvent<TPayload> {
    const prepared = this.buildEventRecord(input, context.now);
    context.transaction.set(context.doc(COLLECTION_NAME, prepared.id), {
      id: prepared.id,
      ...prepared.stored,
    });
    return prepared.response;
  }

  async enqueue<TPayload extends OutboxEventPayload>(
    input: InternalCreateOutboxEventInput<TPayload>
  ): Promise<OutboxEvent<TPayload>> {
    const [createdEvent] = await this.enqueueMany([input]);
    if (!createdEvent) {
      throw CustomError.internalServerError(
        "No se pudo crear el evento de outbox"
      );
    }
    return createdEvent;
  }

  async enqueueMany<TPayload extends OutboxEventPayload>(
    inputs: InternalCreateOutboxEventInput<TPayload>[]
  ): Promise<OutboxEvent<TPayload>[]> {
    if (inputs.length === 0) {
      return [];
    }

    try {
      const chunkSize = this.firestoreConsistencyService.getSafeBatchOperationLimit();
      const createdEvents: OutboxEvent<TPayload>[] = [];

      for (let index = 0; index < inputs.length; index += chunkSize) {
        const chunk = inputs.slice(index, index + chunkSize);
        const createdChunk = await this.firestoreConsistencyService.runBatch(
          "OutboxService.enqueueMany",
          async (context) => chunk.map((input) => this.enqueueInBatch(context, input))
        );
        createdEvents.push(...createdChunk);
      }

      return createdEvents;
    } catch (error) {
      this.handleUnexpectedError("enqueueMany", error);
    }
  }

  async getById<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    id: string
  ): Promise<OutboxEvent<TPayload>> {
    try {
      const doc = await this.firestoreConsistencyService
        .createDocumentReference(COLLECTION_NAME, id)
        .get();

      if (!doc.exists) {
        throw CustomError.notFound(
          `No existe un evento de outbox con id ${id}`
        );
      }

      return mapStoredEvent(
        doc.id,
        doc.data() as StoredOutboxEvent<TPayload>
      );
    } catch (error) {
      this.handleUnexpectedError("getById", error);
    }
  }

  async list<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    filters: ListOutboxEventsFilters = {}
  ): Promise<OutboxEvent<TPayload>[]> {
    try {
      const normalizedLimit = normalizeLimit(filters.limit ?? DEFAULT_FETCH_LIMIT);
      const normalizedType = filters.type?.trim() ?? "";
      const normalizedAggregateType = filters.aggregateType?.trim() ?? "";
      const normalizedAggregateId = filters.aggregateId?.trim() ?? "";
      let query: FirebaseFirestore.Query = FirestoreDataBase.getDB().collection(
        COLLECTION_NAME
      );

      if (normalizedAggregateId !== "") {
        query = query.where("aggregateId", "==", normalizedAggregateId);
      } else if (filters.status != null) {
        query = query.where("status", "==", filters.status);
      } else if (normalizedType !== "") {
        query = query.where("type", "==", normalizedType);
      } else if (normalizedAggregateType !== "") {
        query = query.where("aggregateType", "==", normalizedAggregateType);
      } else {
        query = query.orderBy("createdAt", "desc").limit(normalizedLimit);
      }

      const snapshot = await query.get();

      return snapshot.docs
        .map((doc) =>
          mapStoredEvent(doc.id, doc.data() as StoredOutboxEvent<TPayload>)
        )
        .filter((event) => {
          if (filters.status != null && event.status !== filters.status) {
            return false;
          }
          if (normalizedType !== "" && event.type !== normalizedType) {
            return false;
          }
          if (normalizedAggregateType !== "" && event.aggregateType !== normalizedAggregateType) {
            return false;
          }
          if (normalizedAggregateId !== "" && event.aggregateId !== normalizedAggregateId) {
            return false;
          }
          return true;
        })
        .sort((left, right) => toEventTimeMs(right.createdAt) - toEventTimeMs(left.createdAt))
        .slice(0, normalizedLimit);
    } catch (error) {
      this.handleUnexpectedError("list", error);
    }
  }

  async getPending<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    limit = DEFAULT_FETCH_LIMIT
  ): Promise<OutboxEvent<TPayload>[]> {
    try {
      const snapshot = await FirestoreDataBase.getDB()
        .collection(COLLECTION_NAME)
        .where("status", "==", "PENDING")
        .orderBy("createdAt", "asc")
        .limit(normalizeLimit(limit))
        .get();

      return snapshot.docs.map((doc) =>
        mapStoredEvent(doc.id, doc.data() as StoredOutboxEvent<TPayload>)
      );
    } catch (error) {
      this.handleUnexpectedError("getPending", error);
    }
  }

  async getProcessable<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    limit = DEFAULT_FETCH_LIMIT
  ): Promise<OutboxEvent<TPayload>[]> {
    try {
      const snapshot = await FirestoreDataBase.getDB()
        .collection(COLLECTION_NAME)
        .where("status", "in", PROCESSABLE_OUTBOX_STATUSES)
        .get();

      const nowMs = Date.now();

      return snapshot.docs
        .map((doc) =>
          mapStoredEvent(doc.id, doc.data() as StoredOutboxEvent<TPayload>)
        )
        .filter((event) => resolveProcessableAt(event) <= nowMs)
        .sort((left, right) => resolveProcessableAt(left) - resolveProcessableAt(right))
        .slice(0, normalizeLimit(limit));
    } catch (error) {
      this.handleUnexpectedError("getProcessable", error);
    }
  }

  async getStaleProcessing<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    olderThanSeconds: number,
    limit = DEFAULT_FETCH_LIMIT
  ): Promise<OutboxEvent<TPayload>[]> {
    try {
      const normalizedOlderThanSeconds = Math.max(
        1,
        Math.floor(olderThanSeconds)
      );
      const thresholdMs =
        Date.now() - normalizedOlderThanSeconds * 1000;

      const snapshot = await FirestoreDataBase.getDB()
        .collection(COLLECTION_NAME)
        .where("status", "==", "PROCESSING")
        .get();

      return snapshot.docs
        .map((doc) =>
          mapStoredEvent(doc.id, doc.data() as StoredOutboxEvent<TPayload>)
        )
        .filter((event) => {
          const referenceMs = Math.max(
            toEventTimeMs(event.updatedAt),
            toEventTimeMs(event.createdAt)
          );
          return referenceMs <= thresholdMs;
        })
        .sort((left, right) => {
          const leftMs = Math.max(
            toEventTimeMs(left.updatedAt),
            toEventTimeMs(left.createdAt)
          );
          const rightMs = Math.max(
            toEventTimeMs(right.updatedAt),
            toEventTimeMs(right.createdAt)
          );
          return leftMs - rightMs;
        })
        .slice(0, normalizeLimit(limit));
    } catch (error) {
      this.handleUnexpectedError("getStaleProcessing", error);
    }
  }

  async markProcessing<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    id: string
  ): Promise<OutboxEvent<TPayload>> {
    return this.firestoreConsistencyService.runTransaction(
      "OutboxService.markProcessing",
      async (context) => {
        const ref = context.doc(COLLECTION_NAME, id);
        const snapshot = await context.transaction.get(ref);

        if (!snapshot.exists) {
          throw CustomError.notFound(`No existe un evento de outbox con id ${id}`);
        }

        const current = snapshot.data() as StoredOutboxEvent<TPayload>;
        if (current.status !== "PENDING" && current.status !== "ERROR") {
          throw CustomError.conflict(
            `El evento de outbox ${id} no está disponible para procesamiento`
          );
        }

        const nextAttempts = Math.max(0, Number(current.attempts ?? 0)) + 1;
        const nextStored: StoredOutboxEvent<TPayload> = {
          ...current,
          status: "PROCESSING",
          attempts: nextAttempts,
          updatedAt: context.now,
        };

        delete nextStored.lastError;
        delete nextStored.processedAt;

        context.transaction.update(ref, {
          status: "PROCESSING" as const,
          attempts: nextAttempts,
          updatedAt: context.now,
          lastError: FieldValue.delete(),
          processedAt: FieldValue.delete(),
        });

        return mapStoredEvent(id, nextStored);
      }
    );
  }

  async markDone<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    id: string
  ): Promise<OutboxEvent<TPayload>> {
    return this.firestoreConsistencyService.runTransaction(
      "OutboxService.markDone",
      async (context) => {
        const ref = context.doc(COLLECTION_NAME, id);
        const snapshot = await context.transaction.get(ref);

        if (!snapshot.exists) {
          throw CustomError.notFound(`No existe un evento de outbox con id ${id}`);
        }

        const current = snapshot.data() as StoredOutboxEvent<TPayload>;
        const nextStored: StoredOutboxEvent<TPayload> = {
          ...current,
          status: "DONE",
          processedAt: context.now,
          updatedAt: context.now,
        };

        delete nextStored.lastError;
        delete nextStored.availableAt;

        context.transaction.update(ref, {
          status: "DONE" as const,
          processedAt: context.now,
          updatedAt: context.now,
          lastError: FieldValue.delete(),
          availableAt: FieldValue.delete(),
        });

        return mapStoredEvent(id, nextStored);
      }
    );
  }

  async markError<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    id: string,
    errorMessage: string,
    opts?: { availableAt?: SupportedScheduleInput }
  ): Promise<OutboxEvent<TPayload>> {
    const normalizedErrorMessage = errorMessage.trim();
    if (normalizedErrorMessage === "") {
      throw CustomError.badRequest(
        "El mensaje de error es requerido para marcar un evento de salida como error"
      );
    }

    return this.firestoreConsistencyService.runTransaction(
      "OutboxService.markError",
      async (context) => {
        const ref = context.doc(COLLECTION_NAME, id);
        const snapshot = await context.transaction.get(ref);

        if (!snapshot.exists) {
          throw CustomError.notFound(`No existe un evento de outbox con id ${id}`);
        }

        const current = snapshot.data() as StoredOutboxEvent<TPayload>;
        const availableAt = parseOptionalSchedule(opts?.availableAt);
        const nextStored: StoredOutboxEvent<TPayload> = {
          ...current,
          status: "ERROR",
          lastError: normalizedErrorMessage,
          updatedAt: context.now,
        };

        delete nextStored.processedAt;
        if (availableAt !== undefined) {
          nextStored.availableAt = availableAt;
        } else {
          delete nextStored.availableAt;
        }

        const payload: Record<string, unknown> = {
          status: "ERROR" as const,
          lastError: normalizedErrorMessage,
          updatedAt: context.now,
          processedAt: FieldValue.delete(),
        };

        if (availableAt !== undefined) {
          payload.availableAt = availableAt;
        } else {
          payload.availableAt = FieldValue.delete();
        }

        context.transaction.update(ref, payload);

        return mapStoredEvent(id, nextStored);
      }
    );
  }

  async markPaused<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    id: string,
    errorMessage: string
  ): Promise<OutboxEvent<TPayload>> {
    const normalizedErrorMessage = errorMessage.trim();
    if (normalizedErrorMessage === "") {
      throw CustomError.badRequest(
        "El mensaje de error es requerido para marcar un evento de salida como pausado"
      );
    }

    return this.firestoreConsistencyService.runTransaction(
      "OutboxService.markPaused",
      async (context) => {
        const ref = context.doc(COLLECTION_NAME, id);
        const snapshot = await context.transaction.get(ref);

        if (!snapshot.exists) {
          throw CustomError.notFound(`No existe un evento de outbox con id ${id}`);
        }

        const current = snapshot.data() as StoredOutboxEvent<TPayload>;
        const nextStored: StoredOutboxEvent<TPayload> = {
          ...current,
          status: "PAUSED",
          lastError: normalizedErrorMessage,
          updatedAt: context.now,
        };

        delete nextStored.processedAt;
        delete nextStored.availableAt;

        context.transaction.update(ref, {
          status: "PAUSED" as const,
          lastError: normalizedErrorMessage,
          updatedAt: context.now,
          processedAt: FieldValue.delete(),
          availableAt: FieldValue.delete(),
        });

        return mapStoredEvent(id, nextStored);
      }
    );
  }

  async requeue<TPayload extends OutboxEventPayload = OutboxEventPayload>(
    id: string,
    opts?: { availableAt?: SupportedScheduleInput }
  ): Promise<OutboxEvent<TPayload>> {
    return this.firestoreConsistencyService.runTransaction(
      "OutboxService.requeue",
      async (context) => {
        const ref = context.doc(COLLECTION_NAME, id);
        const snapshot = await context.transaction.get(ref);

        if (!snapshot.exists) {
          throw CustomError.notFound(`No existe un evento de outbox con id ${id}`);
        }

        const current = snapshot.data() as StoredOutboxEvent<TPayload>;
        const availableAt = parseOptionalSchedule(opts?.availableAt);
        const nextStored: StoredOutboxEvent<TPayload> = {
          ...current,
          status: "PENDING",
          updatedAt: context.now,
        };

        delete nextStored.lastError;
        delete nextStored.processedAt;
        if (availableAt !== undefined) {
          nextStored.availableAt = availableAt;
        } else {
          delete nextStored.availableAt;
        }

        const payload: Record<string, unknown> = {
          status: "PENDING" as const,
          updatedAt: context.now,
          lastError: FieldValue.delete(),
          processedAt: FieldValue.delete(),
        };

        if (availableAt !== undefined) {
          payload.availableAt = availableAt;
        } else {
          payload.availableAt = FieldValue.delete();
        }

        context.transaction.update(ref, payload);

        return mapStoredEvent(id, nextStored);
      }
    );
  }
}
