import { Timestamp } from "firebase-admin/firestore";
import type {
  DocumentReference,
  Firestore,
  SetOptions,
  Transaction,
  WriteBatch,
} from "firebase-admin/firestore";
import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import { logger } from "../../infrastructure/logger/logger";

export const SAFE_FIRESTORE_BATCH_OPERATION_LIMIT = 450;

function buildDocumentReference(
  db: Firestore,
  collectionName: string,
  id?: string
): DocumentReference {
  if (id != null && id.trim() !== "") {
    return db.collection(collectionName).doc(id);
  }
  return db.collection(collectionName).doc();
}

function buildSubcollectionDocumentReference(
  db: Firestore,
  parentCollection: string,
  parentId: string,
  subcollectionName: string,
  id?: string
): DocumentReference {
  const collectionRef = db
    .collection(parentCollection)
    .doc(parentId)
    .collection(subcollectionName);
  if (id != null && id.trim() !== "") {
    return collectionRef.doc(id);
  }
  return collectionRef.doc();
}

function logConsistencyError(error: unknown, operationName: string): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  logger.error(`[FirestoreConsistencyService] ${operationName} failed. detalle=${detail}`);
}

export class TrackedFirestoreBatch {
  private readonly rawBatchInstance: WriteBatch;
  private operationCountValue = 0;

  constructor(
    private readonly db: Firestore,
    readonly now: Timestamp = FirestoreDataBase.generateTimeStamp(),
    private readonly maxOperations = SAFE_FIRESTORE_BATCH_OPERATION_LIMIT
  ) {
    this.rawBatchInstance = db.batch();
  }

  get operationCount(): number {
    return this.operationCountValue;
  }

  get remainingOperations(): number {
    return Math.max(0, this.maxOperations - this.operationCountValue);
  }

  get rawBatch(): WriteBatch {
    return this.rawBatchInstance;
  }

  doc(collectionName: string, id?: string): DocumentReference {
    return buildDocumentReference(this.db, collectionName, id);
  }

  subdoc(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    id?: string
  ): DocumentReference {
    return buildSubcollectionDocumentReference(
      this.db,
      parentCollection,
      parentId,
      subcollectionName,
      id
    );
  }

  private ensureCapacity(nextOperations = 1): void {
    if (this.operationCountValue + nextOperations > this.maxOperations) {
      throw CustomError.internalServerError(
        `La operación excede el límite seguro de ${this.maxOperations} escrituras por batch`
      );
    }
  }

  set(ref: DocumentReference, data: object, options?: SetOptions): this {
    this.ensureCapacity();
    if (options != null) {
      this.rawBatchInstance.set(ref, data, options);
    } else {
      this.rawBatchInstance.set(ref, data);
    }
    this.operationCountValue += 1;
    return this;
  }

  update(ref: DocumentReference, data: object): this {
    this.ensureCapacity();
    this.rawBatchInstance.update(ref, data);
    this.operationCountValue += 1;
    return this;
  }

  delete(ref: DocumentReference): this {
    this.ensureCapacity();
    this.rawBatchInstance.delete(ref);
    this.operationCountValue += 1;
    return this;
  }

  async commit(): Promise<number> {
    if (this.operationCountValue === 0) {
      return 0;
    }

    const committedOperations = this.operationCountValue;
    await this.rawBatchInstance.commit();
    this.operationCountValue = 0;
    return committedOperations;
  }
}

export interface FirestoreTransactionContext {
  db: Firestore;
  transaction: Transaction;
  now: Timestamp;
  doc(collectionName: string, id?: string): DocumentReference;
  subdoc(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    id?: string
  ): DocumentReference;
}

export interface FirestoreBatchContext {
  db: Firestore;
  batch: TrackedFirestoreBatch;
  now: Timestamp;
  doc(collectionName: string, id?: string): DocumentReference;
  subdoc(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    id?: string
  ): DocumentReference;
}

export class FirestoreConsistencyService {
  getDB(): Firestore {
    return FirestoreDataBase.getDB();
  }

  getSafeBatchOperationLimit(): number {
    return SAFE_FIRESTORE_BATCH_OPERATION_LIMIT;
  }

  createDocumentReference(collectionName: string, id?: string): DocumentReference {
    return buildDocumentReference(this.getDB(), collectionName, id);
  }

  createSubcollectionDocumentReference(
    parentCollection: string,
    parentId: string,
    subcollectionName: string,
    id?: string
  ): DocumentReference {
    return buildSubcollectionDocumentReference(
      this.getDB(),
      parentCollection,
      parentId,
      subcollectionName,
      id
    );
  }

  createBatchContext(
    now: Timestamp = FirestoreDataBase.generateTimeStamp()
  ): FirestoreBatchContext {
    const db = this.getDB();
    const batch = new TrackedFirestoreBatch(
      db,
      now,
      SAFE_FIRESTORE_BATCH_OPERATION_LIMIT
    );

    return {
      db,
      batch,
      now,
      doc: (collectionName: string, id?: string) =>
        buildDocumentReference(db, collectionName, id),
      subdoc: (
        parentCollection: string,
        parentId: string,
        subcollectionName: string,
        id?: string
      ) =>
        buildSubcollectionDocumentReference(
          db,
          parentCollection,
          parentId,
          subcollectionName,
          id
        ),
    };
  }

  async runTransaction<T>(
    operationName: string,
    handler: (context: FirestoreTransactionContext) => Promise<T>
  ): Promise<T> {
    const db = this.getDB();
    const now = FirestoreDataBase.generateTimeStamp();

    try {
      return await db.runTransaction(async (transaction) =>
        handler({
          db,
          transaction,
          now,
          doc: (collectionName: string, id?: string) =>
            buildDocumentReference(db, collectionName, id),
          subdoc: (
            parentCollection: string,
            parentId: string,
            subcollectionName: string,
            id?: string
          ) =>
            buildSubcollectionDocumentReference(
              db,
              parentCollection,
              parentId,
              subcollectionName,
              id
            ),
        })
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logConsistencyError(error, `transaction:${operationName}`);
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async runBatch<T>(
    operationName: string,
    handler: (context: FirestoreBatchContext) => Promise<T>
  ): Promise<T> {
    const context = this.createBatchContext();

    try {
      const result = await handler(context);
      await context.batch.commit();
      return result;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logConsistencyError(error, `batch:${operationName}`);
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }
}
