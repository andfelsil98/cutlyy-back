import {
  FieldValue,
  Timestamp,
  type DocumentReference,
} from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import { logger } from "../../infrastructure/logger/logger";
import {
  FirestoreConsistencyService,
  type FirestoreTransactionContext,
} from "./firestore-consistency.service";

const COLLECTION_NAME = "ExternalDispatches";
const DEFAULT_STALE_SECONDS = 5 * 60;

type ExternalDispatchStatus =
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "AMBIGUOUS";

type StoredExternalDispatch = {
  channel: "WHATSAPP" | "PUSH";
  aggregateType: string;
  aggregateId: string;
  description: string;
  status: ExternalDispatchStatus;
  attempts: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt?: Timestamp;
  lastError?: string;
  provider?: string;
  providerMessageId?: string;
  resultSummary?: string;
};

export class ExternalDispatchAmbiguousError extends Error {
  constructor(
    public readonly dispatchId: string,
    message: string
  ) {
    super(message);
    this.name = "ExternalDispatchAmbiguousError";
  }
}

interface BeginExternalDispatchInput {
  dispatchId: string;
  channel: "WHATSAPP" | "PUSH";
  aggregateType: string;
  aggregateId: string;
  description: string;
}

type BeginExternalDispatchResult = "STARTED" | "ALREADY_SUCCEEDED";

export class ExternalDispatchService {
  constructor(
    private readonly firestoreConsistencyService: FirestoreConsistencyService =
      new FirestoreConsistencyService(),
    private readonly staleSeconds = DEFAULT_STALE_SECONDS
  ) {}

  async begin(
    input: BeginExternalDispatchInput
  ): Promise<BeginExternalDispatchResult> {
    const dispatchId = input.dispatchId.trim();
    if (dispatchId === "") {
      throw CustomError.badRequest(
        "dispatchId es requerido para iniciar un external dispatch"
      );
    }

    return this.firestoreConsistencyService.runTransaction(
      "ExternalDispatchService.begin",
      async (context) => {
        const ref = context.doc(COLLECTION_NAME, dispatchId);
        const snapshot = await context.transaction.get(ref);

        if (!snapshot.exists) {
          context.transaction.set(ref, {
            id: dispatchId,
            channel: input.channel,
            aggregateType: input.aggregateType.trim(),
            aggregateId: input.aggregateId.trim(),
            description: input.description.trim(),
            status: "IN_PROGRESS" as const,
            attempts: 1,
            createdAt: context.now,
            updatedAt: context.now,
          });
          return "STARTED";
        }

        const current = snapshot.data() as StoredExternalDispatch;
        if (current.status === "SUCCEEDED") {
          return "ALREADY_SUCCEEDED";
        }

        if (current.status === "AMBIGUOUS") {
          throw new ExternalDispatchAmbiguousError(
            dispatchId,
            `El envío externo ${dispatchId} quedó ambiguo y requiere revisión manual antes de reintentarlo`
          );
        }

        if (current.status === "IN_PROGRESS") {
          if (this.isStale(current, context)) {
            context.transaction.update(ref, {
              status: "AMBIGUOUS" as const,
              updatedAt: context.now,
              lastError:
                "Se detectó un envío externo en progreso que quedó stale; el resultado es ambiguo y requiere revisión manual",
            });
            throw new ExternalDispatchAmbiguousError(
              dispatchId,
              `El envío externo ${dispatchId} quedó ambiguo después de detectar un IN_PROGRESS stale`
            );
          }

          throw CustomError.conflict(
            `El envío externo ${dispatchId} ya está en progreso`,
            "EXTERNAL_DISPATCH_IN_PROGRESS"
          );
        }

        context.transaction.update(ref, {
          status: "IN_PROGRESS" as const,
          attempts: Math.max(0, Number(current.attempts ?? 0)) + 1,
          updatedAt: context.now,
          lastError: FieldValue.delete(),
          completedAt: FieldValue.delete(),
          provider: FieldValue.delete(),
          providerMessageId: FieldValue.delete(),
          resultSummary: FieldValue.delete(),
        });

        return "STARTED";
      }
    );
  }

  async markSucceeded(
    dispatchId: string,
    result?: {
      provider?: string;
      providerMessageId?: string;
      resultSummary?: string;
    }
  ): Promise<void> {
    await this.updateStatus(
      "ExternalDispatchService.markSucceeded",
      dispatchId,
      (context, ref) => {
        const payload: Record<string, unknown> = {
          status: "SUCCEEDED" as const,
          updatedAt: context.now,
          completedAt: context.now,
          lastError: FieldValue.delete(),
        };

        if (result?.provider?.trim()) {
          payload.provider = result.provider.trim();
        } else {
          payload.provider = FieldValue.delete();
        }

        if (result?.providerMessageId?.trim()) {
          payload.providerMessageId = result.providerMessageId.trim();
        } else {
          payload.providerMessageId = FieldValue.delete();
        }

        if (result?.resultSummary?.trim()) {
          payload.resultSummary = result.resultSummary.trim();
        } else {
          payload.resultSummary = FieldValue.delete();
        }

        context.transaction.update(ref, payload);
      }
    );
  }

  async markFailed(dispatchId: string, errorMessage: string): Promise<void> {
    const normalizedError = errorMessage.trim();
    if (normalizedError === "") {
      throw CustomError.badRequest(
        "El mensaje de error es requerido para marcar el despacho externo como fallido"
      );
    }

    await this.updateStatus(
      "ExternalDispatchService.markFailed",
      dispatchId,
      (context, ref) => {
        context.transaction.update(ref, {
          status: "FAILED" as const,
          updatedAt: context.now,
          completedAt: FieldValue.delete(),
          lastError: normalizedError,
          provider: FieldValue.delete(),
          providerMessageId: FieldValue.delete(),
          resultSummary: FieldValue.delete(),
        });
      }
    );
  }

  async markAmbiguous(dispatchId: string, errorMessage: string): Promise<void> {
    const normalizedError = errorMessage.trim();
    if (normalizedError === "") {
      throw CustomError.badRequest(
        "El mensaje de error es requerido para marcar el despacho externo como ambiguo"
      );
    }

    await this.updateStatus(
      "ExternalDispatchService.markAmbiguous",
      dispatchId,
      (context, ref) => {
        context.transaction.update(ref, {
          status: "AMBIGUOUS" as const,
          updatedAt: context.now,
          completedAt: FieldValue.delete(),
          lastError: normalizedError,
        });
      }
    );
  }

  async forceReset(dispatchId: string): Promise<void> {
    const normalizedDispatchId = dispatchId.trim();
    if (normalizedDispatchId === "") {
      throw CustomError.badRequest(
        "dispatchId es requerido para resetear un external dispatch"
      );
    }

    await this.firestoreConsistencyService
      .runTransaction("ExternalDispatchService.forceReset", async (context) => {
        const ref = context.doc(COLLECTION_NAME, normalizedDispatchId);
        const snapshot = await context.transaction.get(ref);
        if (!snapshot.exists) {
          return;
        }

        context.transaction.update(ref, {
          status: "FAILED" as const,
          updatedAt: context.now,
          completedAt: FieldValue.delete(),
          lastError: "Reset manual solicitado para permitir un nuevo intento",
          provider: FieldValue.delete(),
          providerMessageId: FieldValue.delete(),
          resultSummary: FieldValue.delete(),
        });
      })
      .catch((error) => {
        if (error instanceof CustomError) throw error;
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        logger.error(
          `[ExternalDispatchService] No se pudo resetear el external dispatch ${normalizedDispatchId}. detalle=${detail}`
        );
        throw CustomError.internalServerError("Error interno del servidor");
      });
  }

  private async updateStatus(
    operationName: string,
    dispatchId: string,
    updater: (
      context: FirestoreTransactionContext,
      ref: DocumentReference
    ) => void
  ): Promise<void> {
    const normalizedDispatchId = dispatchId.trim();
    if (normalizedDispatchId === "") {
      throw CustomError.badRequest(
        "dispatchId es requerido para actualizar el external dispatch"
      );
    }

    await this.firestoreConsistencyService.runTransaction(operationName, async (context) => {
      const ref = context.doc(COLLECTION_NAME, normalizedDispatchId);
      const snapshot = await context.transaction.get(ref);
      if (!snapshot.exists) {
        throw CustomError.notFound(
          `No existe un external dispatch con id ${normalizedDispatchId}`
        );
      }

      updater(context, ref);
    });
  }

  private isStale(
    dispatch: StoredExternalDispatch,
    context: FirestoreTransactionContext
  ): boolean {
    const updatedAtMs = dispatch.updatedAt?.toDate().getTime() ?? 0;
    const createdAtMs = dispatch.createdAt?.toDate().getTime() ?? 0;
    const referenceMs = Math.max(updatedAtMs, createdAtMs);
    const staleThresholdMs =
      context.now.toDate().getTime() - Math.max(1, this.staleSeconds) * 1000;

    return referenceMs <= staleThresholdMs;
  }
}
