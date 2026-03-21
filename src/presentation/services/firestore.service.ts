import { Timestamp } from "firebase-admin/firestore";
import type { Firestore, Query } from "firebase-admin/firestore";
import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { DbFilters } from "../../domain/interfaces/dbFilters.interface";
import {
  buildPagination,
  type PaginatedResult,
  type PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import { logger } from "../../infrastructure/logger/logger";

/** Campos de fecha en Firestore (Timestamp); al cliente se envían como string ISO */
interface DocTimestamps {
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
  cancelledAt?: Timestamp | null;
  deletedAt?: Timestamp | null;
}

const SLOW_QUERY_THRESHOLD_MS = 500;

function logUnexpectedError(error: unknown, context: string): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = [
    `[FirestoreService] ${context}: ${err.message}`,
    "",
    "Error original:",
    err.stack ?? "(no stack)",
  ].join("\n");
  logger.error(message);
}

function logQueryPerformance(
  method: string,
  collection: string,
  startMs: number,
  docCount?: number
): void {
  const elapsed = Date.now() - startMs;
  if (elapsed >= SLOW_QUERY_THRESHOLD_MS) {
    logger.warn(
      `[FirestoreService] SLOW QUERY: ${method} on ${collection} took ${elapsed}ms` +
        (docCount != null ? ` (${docCount} docs)` : "")
    );
  }
}

export default class FirestoreService {
  static getDB(): Firestore {
    return FirestoreDataBase.getDB();
  }

  /** Convierte Timestamp de Firestore a string ISO para el cliente */
  private static toISO(
    value: Timestamp | null | undefined
  ): string | null {
    if (!value) return null;
    if (value instanceof Timestamp) return value.toDate().toISOString();
    return null;
  }

  private static formatTimestamps(data: DocTimestamps): {
    createdAt: string | null;
    updatedAt: string | null;
    cancelledAt: string | null;
    deletedAt: string | null;
  } {
    return {
      createdAt: this.toISO(data.createdAt),
      updatedAt: this.toISO(data.updatedAt),
      cancelledAt: this.toISO(data.cancelledAt),
      deletedAt: this.toISO(data.deletedAt),
    };
  }

  static async getAll<T>(
    collectionName: string,
    filters: DbFilters[] = [],
    orderBy?: { field: string; direction: "asc" | "desc" },
    selectFields?: string[]
  ): Promise<(T & { id: string })[]> {
    try {
      const startMs = Date.now();
      let query: Query = this.getDB().collection(collectionName);
      filters.forEach(({ field, operator, value }) => {
        query = query.where(field, operator, value);
      });
      if (orderBy) {
        query = query.orderBy(orderBy.field, orderBy.direction);
      }
      if (selectFields && selectFields.length > 0) {
        query = query.select(...selectFields);
      }
      const snapshot = await query.get();
      logQueryPerformance("getAll", collectionName, startMs, snapshot.size);
      return snapshot.docs.map((doc) => {
        const data = doc.data() as T & DocTimestamps;
        const { createdAt, updatedAt, cancelledAt, deletedAt } = this.formatTimestamps(data);
        const objResponse = {
          id: doc.id,
          ...data,
          ...(createdAt != null && { createdAt }),
          ...(updatedAt != null && { updatedAt }),
          ...(cancelledAt != null && { cancelledAt }),
          ...(deletedAt != null && { deletedAt }),
        };
        return objResponse as T & { id: string };
      });
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "getAll");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async getAllPaginated<T>(
    collectionName: string,
    pagination: PaginationParams,
    filters: DbFilters[] = [],
    orderBy: { field: string; direction: "asc" | "desc" } = {
      field: "createdAt",
      direction: "desc",
    },
    selectFields?: string[]
  ): Promise<PaginatedResult<T & { id: string }>> {
    try {
      const startMs = Date.now();
      const db = this.getDB();
      let baseQuery: Query = db.collection(collectionName);
      filters.forEach(({ field, operator, value }) => {
        baseQuery = baseQuery.where(field, operator, value);
      });
      baseQuery = baseQuery.orderBy(orderBy.field, orderBy.direction);
      if (selectFields && selectFields.length > 0) {
        baseQuery = baseQuery.select(...selectFields);
      }

      const countAgg = (baseQuery as Query & { count(): { get(): Promise<{ data(): { count: number } }> } }).count();
      const countSnap = await countAgg.get();
      const total = countSnap.data().count;

      const { page, pageSize } = pagination;
      const offset = (page - 1) * pageSize;
      const paginatedQuery = baseQuery.limit(pageSize).offset(offset);
      const snapshot = await paginatedQuery.get();
      logQueryPerformance("getAllPaginated", collectionName, startMs, snapshot.size);

      const data = snapshot.docs.map((doc) => {
        const docData = doc.data() as T & DocTimestamps;
        const { createdAt, updatedAt, cancelledAt, deletedAt } = this.formatTimestamps(docData);
        const objResponse = {
          id: doc.id,
          ...docData,
          ...(createdAt != null && { createdAt }),
          ...(updatedAt != null && { updatedAt }),
          ...(cancelledAt != null && { cancelledAt }),
          ...(deletedAt != null && { deletedAt }),
        };
        return objResponse as T & { id: string };
      });

      return {
        data,
        total,
        pagination: buildPagination(page, pageSize, total),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "getAllPaginated");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async getById<T>(
    collectionName: string,
    id: string
  ): Promise<T & { id: string }> {
    try {
      const db = this.getDB();
      const doc = await db.collection(collectionName).doc(id).get();
      if (!doc.exists) {
        throw CustomError.notFound(
          `No se encontró el documento con id ${id} en la colección ${collectionName}`
        );
      }
      const data = doc.data() as T & DocTimestamps;
      const { createdAt, updatedAt, cancelledAt, deletedAt } = this.formatTimestamps(data);
      return {
        id: doc.id,
        ...data,
        ...(createdAt != null && { createdAt }),
        ...(updatedAt != null && { updatedAt }),
        ...(cancelledAt != null && { cancelledAt }),
        ...(deletedAt != null && { deletedAt }),
      } as T & { id: string };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "getById");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  /** Retorno: mismo T pero con `createdAt` como string si era Timestamp. El documento guardado incluye `id`. */
  static async create<T extends object>(
    collectionName: string,
    data: T
  ): Promise<{ id: string } & { [K in keyof T]: T[K] extends Timestamp ? string : T[K] }> {
    try {
      const db = this.getDB();
      const docRef = db.collection(collectionName).doc();
      const payload = { id: docRef.id, ...data };
      await docRef.set(payload);
      let result: Record<string, unknown> = { ...payload } as Record<string, unknown>;
      const raw = payload as Record<string, unknown>;
      if (raw?.createdAt) {
        const { createdAt } = this.formatTimestamps({
          createdAt: raw.createdAt as Timestamp | null,
        });
        if (createdAt) result = { ...payload, createdAt } as Record<string, unknown>;
      }
      return { id: docRef.id, ...result } as { id: string } & {
        [K in keyof T]: T[K] extends Timestamp ? string : T[K];
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "create");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  /**
   * Crea un documento en una subcolección: parentCollection/parentId/subcollectionName.
   * data debe contener "id" como id del documento en la subcolección.
   */
  static async createInSubcollection<T extends { id: string }>(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    data: T
  ): Promise<T> {
    try {
      const db = this.getDB();
      const docId = data.id.trim();
      const docRef = db
        .collection(parentCollection)
        .doc(parentId)
        .collection(subcollectionName)
        .doc(docId);
      await docRef.set(data);
      return data;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "createInSubcollection");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async getAllFromSubcollection<T>(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    options?: {
      filters?: DbFilters[];
      limit?: number;
    }
  ): Promise<(T & { id: string })[]> {
    try {
      const db = this.getDB();
      let query: Query = db
        .collection(parentCollection)
        .doc(parentId)
        .collection(subcollectionName);

      if (options?.filters) {
        for (const { field, operator, value } of options.filters) {
          query = query.where(field, operator, value);
        }
      }
      if (options?.limit != null && options.limit > 0) {
        query = query.limit(options.limit);
      }

      const snapshot = await query.get();

      return snapshot.docs.map((doc) => {
        const data = doc.data() as T;
        return { id: doc.id, ...data };
      });
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "getAllFromSubcollection");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async subcollectionDocumentExists(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    docId: string
  ): Promise<boolean> {
    try {
      const db = this.getDB();
      const doc = await db
        .collection(parentCollection)
        .doc(parentId)
        .collection(subcollectionName)
        .doc(docId)
        .get();
      return doc.exists;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "subcollectionDocumentExists");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async deleteSubcollectionDocument(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    docId: string
  ): Promise<void> {
    try {
      const db = this.getDB();
      await db
        .collection(parentCollection)
        .doc(parentId)
        .collection(subcollectionName)
        .doc(docId)
        .delete();
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "deleteSubcollectionDocument");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async deleteSubcollectionDocuments(
    parentCollection: string,
    parentId: string,
    subcollectionName: string
  ): Promise<number> {
    try {
      const db = this.getDB();
      const snapshot = await db
        .collection(parentCollection)
        .doc(parentId)
        .collection(subcollectionName)
        .get();

      const deletions = snapshot.docs.map((doc) => doc.ref.delete());
      await Promise.all(deletions);
      return snapshot.size;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "deleteSubcollectionDocuments");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async update(
    collectionName: string,
    id: string,
    data: object
  ): Promise<object> {
    try {
      const db = this.getDB();
      const docRef = db.collection(collectionName).doc(id);
      const doc = await docRef.get();
      if (!doc.exists) {
        throw CustomError.notFound(
          `No se encontró el documento con id ${id} en la colección ${collectionName}`
        );
      }
      await docRef.update(data);
      const result = { ...data };
      if ("updatedAt" in result) delete (result as Record<string, unknown>).updatedAt;
      return result;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "update");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  static async delete(
    collectionName: string,
    id: string
  ): Promise<{ id: string; message: string }> {
    try {
      const db = this.getDB();
      const docRef = db.collection(collectionName).doc(id);
      const doc = await docRef.get();
      if (!doc.exists) {
        throw CustomError.notFound(
          `No se puede eliminar: no existe el documento con id ${id} en la colección ${collectionName}`
        );
      }
      await docRef.delete();
      return {
        id,
        message: `Eliminado correctamente de ${collectionName}`,
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logUnexpectedError(error, "delete");
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }
}
