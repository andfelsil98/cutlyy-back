import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import type { Timestamp } from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import type { User } from "../../domain/interfaces/user.interface";
import { ensureColombiaCountryCode } from "../../domain/utils/string.utils";
import { logger } from "../../infrastructure/logger/logger";
import FirestoreService from "./firestore.service";
import { SchedulingIntegrityService } from "./scheduling-integrity.service";

const COLLECTION_NAME = "Users";
const DELETED_USERS_COLLECTION = "DeletedUsers";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";

export interface CreateUserData {
  phone: string;
  name: string;
  email: string;
  document: string;
  documentTypeName: string;
  documentTypeId: string;
}

export interface UpdateUserData {
  profilePhotoUrl?: string;
  phone?: string;
  name?: string;
  email?: string;
}

export class UserService {
  constructor(
    private readonly schedulingIntegrityService: SchedulingIntegrityService =
      new SchedulingIntegrityService()
  ) {}

  async existsByEmail(email: string): Promise<boolean> {
    const users = await FirestoreService.getAll<User>(COLLECTION_NAME, [
      { field: "email", operator: "==", value: email },
    ]);
    return users.length > 0;
  }

  async existsByDocument(document: string): Promise<boolean> {
    const users = await FirestoreService.getAll<User>(COLLECTION_NAME, [
      { field: "document", operator: "==", value: document },
    ]);
    return users.length > 0;
  }

  async createUser(data: CreateUserData): Promise<User> {
    try {
      const doc = {
        phone: ensureColombiaCountryCode(data.phone),
        name: data.name,
        email: data.email,
        document: data.document,
        documentTypeName: data.documentTypeName,
        documentTypeId: data.documentTypeId,
        profilePhotoUrl: "",
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };
      const result = await FirestoreService.create(COLLECTION_NAME, doc);
      return result as User;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async getByEmail(email: string): Promise<User | null> {
    const users = await FirestoreService.getAll<User>(COLLECTION_NAME, [
      { field: "email", operator: "==", value: email },
    ]);
    return users[0] ?? null;
  }

  async getAllUsers(
    params: PaginationParams & { userId?: string; document?: string; name?: string }
  ): Promise<PaginatedResult<User>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const requestedName =
        params.name != null && params.name.trim() !== ""
          ? params.name.trim()
          : undefined;
      const filters = [
        ...(params.userId != null && params.userId.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.userId.trim() }]
          : []),
        ...(params.document != null && params.document.trim() !== ""
          ? [
              {
                field: "document" as const,
                operator: "==" as const,
                value: params.document.trim(),
              },
            ]
          : []),
        ...(requestedName != null
          ? [
              {
                field: "name" as const,
                operator: ">=" as const,
                value: requestedName,
              },
              {
                field: "name" as const,
                operator: "<=" as const,
                value: `${requestedName}\uf8ff`,
              },
            ]
          : []),
      ];

      return await FirestoreService.getAllPaginated<User>(
        COLLECTION_NAME,
        { page, pageSize },
        filters,
        requestedName != null
          ? { field: "name", direction: "asc" }
          : undefined
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async getById(id: string): Promise<User | null> {
    const users = await FirestoreService.getAll<User>(COLLECTION_NAME, [
      { field: "id", operator: "==", value: id },
    ]);
    return users[0] ?? null;
  }

  async getByDocument(document: string): Promise<User | null> {
    const users = await FirestoreService.getAll<User>(COLLECTION_NAME, [
      { field: "document", operator: "==", value: document },
    ]);
    return users[0] ?? null;
  }

  async updateUser(id: string, data: UpdateUserData): Promise<User> {
    try {
      const user = await this.getById(id);
      if (!user) {
        throw CustomError.notFound("No existe un usuario con este id");
      }

      const nextEmail = data.email?.trim().toLowerCase();
      if (nextEmail && nextEmail !== user.email.toLowerCase()) {
        const existingUserByEmail = await this.getByEmail(nextEmail);
        if (existingUserByEmail && existingUserByEmail.id !== user.id) {
          throw CustomError.conflict("Ya existe un usuario registrado con este correo");
        }
      }

      const payload = {
        ...(data.profilePhotoUrl !== undefined && { profilePhotoUrl: data.profilePhotoUrl }),
        ...((data.phone !== undefined) && { phone: ensureColombiaCountryCode(data.phone) }),
        ...(data.name !== undefined && { name: data.name }),
        ...(nextEmail !== undefined && { email: nextEmail }),
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };

      await FirestoreService.update(COLLECTION_NAME, user.id, payload);
      await this.syncFirebaseAuthUserIfNeeded(user.email, {
        ...(nextEmail !== undefined && { email: nextEmail }),
        ...(data.name !== undefined && { displayName: data.name }),
      });

      const updatedUser = await this.getById(user.id);
      if (!updatedUser) {
        throw CustomError.internalServerError("No se pudo recuperar el usuario actualizado");
      }
      return updatedUser;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteUser(
    document: string,
    opts: { deletedByUid?: string; deletedByEmail?: string }
  ): Promise<{ id: string; message: string }> {
    try {
      const sanitizedDocument = document.trim();
      const user = await this.getByDocument(sanitizedDocument);
      if (!user) {
        throw CustomError.notFound("No existe un usuario con este número de documento");
      }

      await this.schedulingIntegrityService.ensureEmployeeCanBeDeleted([
        user.document,
        user.id,
      ]);

      await this.deleteFirebaseAuthUserByEmail(user.email);

      const [membershipsByDocument, membershipsById] = await Promise.all([
        FirestoreService.getAll<BusinessMembership>(BUSINESS_MEMBERSHIPS_COLLECTION, [
          {
            field: "userId",
            operator: "==",
            value: user.document,
          },
        ]),
        FirestoreService.getAll<BusinessMembership>(BUSINESS_MEMBERSHIPS_COLLECTION, [
          {
            field: "userId",
            operator: "==",
            value: user.id,
          },
        ]),
      ]);

      const membershipsMap = new Map<string, BusinessMembership>();
      membershipsByDocument.forEach((membership) => membershipsMap.set(membership.id, membership));
      membershipsById.forEach((membership) => membershipsMap.set(membership.id, membership));
      const memberships = Array.from(membershipsMap.values());

      const deletedAt = FirestoreDataBase.generateTimeStamp();

      await this.markMembershipsAsDeleted(memberships, deletedAt);
      await FirestoreService.deleteSubcollectionDocuments(
        COLLECTION_NAME,
        user.id,
        "businessMemberships"
      );

      const deletedUserPayload = {
        id: user.id,
        phone: user.phone,
        name: user.name,
        email: user.email,
        document: user.document,
        documentTypeName: user.documentTypeName,
        documentTypeId: user.documentTypeId,
        profilePhotoUrl: user.profilePhotoUrl,
        createdAt: user.createdAt,
        deletedAt,
        ...(opts.deletedByUid && { deletedByUid: opts.deletedByUid }),
        ...(opts.deletedByEmail && { deletedByEmail: opts.deletedByEmail }),
      };

      await FirestoreService.create(DELETED_USERS_COLLECTION, deletedUserPayload);
      await FirestoreService.delete(COLLECTION_NAME, user.id);

      return {
        id: user.id,
        message:
          "Usuario eliminado correctamente. Registro de autenticación eliminado, membresías marcadas como eliminadas y subcolección de membresías del usuario eliminada.",
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async markMembershipsAsDeleted(
    memberships: BusinessMembership[],
    deletedAt: Timestamp
  ): Promise<void> {
    const updates = memberships.map((membership) => {
      if (membership.status === "DELETED") {
        return Promise.resolve();
      }

      const payload = {
        status: "DELETED" as const,
        deletedAt,
      };
      return FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membership.id, payload);
    });

    await Promise.all(updates);
  }

  private async deleteFirebaseAuthUserByEmail(email: string): Promise<void> {
    if (email.trim() === "") {
      return;
    }

    const auth = FirestoreDataBase.getAdmin().auth();
    try {
      const firebaseUser = await auth.getUserByEmail(email);
      await auth.deleteUser(firebaseUser.uid);
    } catch (error) {
      if (this.isFirebaseUserNotFoundError(error)) {
        return;
      }

      logger.error(
        `[UserService.deleteFirebaseAuthUserByEmail] Firebase Auth delete failed. code=${this.extractFirebaseAuthErrorCode(
          error
        )} details=${this.extractFirebaseAuthErrorText(error)}`
      );

      throw CustomError.internalServerError(
        "No se pudo eliminar el usuario en el sistema de autenticación"
      );
    }
  }

  private async syncFirebaseAuthUserIfNeeded(
    currentEmail: string,
    nextData: { email?: string; displayName?: string }
  ): Promise<void> {
    if (!nextData.email && !nextData.displayName) {
      return;
    }

    const auth = FirestoreDataBase.getAdmin().auth();
    try {
      const firebaseUser = await auth.getUserByEmail(currentEmail);
      await auth.updateUser(firebaseUser.uid, nextData);
    } catch (error) {
      const code = this.extractFirebaseAuthErrorCode(error);

      if (this.isFirebaseUserNotFoundError(error)) {
        return;
      }
      if (code === "auth/email-already-exists") {
        throw CustomError.conflict("Ya existe un usuario con este correo en el sistema de autenticación");
      }
      if (code === "auth/invalid-email") {
        throw CustomError.badRequest("El correo no es válido para autenticación");
      }

      throw CustomError.internalServerError(
        "No se pudo actualizar el usuario en el sistema de autenticación"
      );
    }
  }

  private extractFirebaseAuthErrorCode(error: unknown): string {
    if (typeof error !== "object" || error == null) {
      return "";
    }

    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";
    if (code !== "") {
      return code.toLowerCase();
    }

    const nestedCode =
      "errorInfo" in error &&
      typeof (error as { errorInfo?: unknown }).errorInfo === "object" &&
      (error as { errorInfo?: Record<string, unknown> }).errorInfo != null &&
      typeof (error as { errorInfo: Record<string, unknown> }).errorInfo.code === "string"
        ? (error as { errorInfo: { code: string } }).errorInfo.code
        : "";
    return nestedCode.toLowerCase();
  }

  private isFirebaseUserNotFoundCode(code: string): boolean {
    const normalizedCode = code.trim().toLowerCase();
    return (
      normalizedCode === "auth/user-not-found" ||
      normalizedCode === "user-not-found" ||
      normalizedCode === "auth/user_not_found" ||
      normalizedCode === "user_not_found"
    );
  }

  private extractFirebaseAuthErrorText(error: unknown): string {
    if (typeof error !== "object" || error == null) {
      return "";
    }

    const topLevelMessage =
      "message" in error && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";

    const nestedMessage =
      "errorInfo" in error &&
      typeof (error as { errorInfo?: unknown }).errorInfo === "object" &&
      (error as { errorInfo?: Record<string, unknown> }).errorInfo != null &&
      typeof (error as { errorInfo: Record<string, unknown> }).errorInfo.message === "string"
        ? (error as { errorInfo: { message: string } }).errorInfo.message
        : "";

    const nestedDetails =
      "errorInfo" in error &&
      typeof (error as { errorInfo?: unknown }).errorInfo === "object" &&
      (error as { errorInfo?: Record<string, unknown> }).errorInfo != null &&
      typeof (error as { errorInfo: Record<string, unknown> }).errorInfo.details === "string"
        ? (error as { errorInfo: { details: string } }).errorInfo.details
        : "";

    const serialized = (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return "";
      }
    })();

    return `${topLevelMessage} ${nestedMessage} ${nestedDetails} ${serialized}`
      .trim()
      .toLowerCase();
  }

  private isFirebaseUserNotFoundError(error: unknown): boolean {
    const code = this.extractFirebaseAuthErrorCode(error);
    if (this.isFirebaseUserNotFoundCode(code)) {
      return true;
    }

    const errorText = this.extractFirebaseAuthErrorText(error);
    return (
      errorText.includes("user-not-found") ||
      errorText.includes("user_not_found") ||
      errorText.includes("no user record") ||
      errorText.includes("user may have been deleted") ||
      errorText.includes("no user exists")
    );
  }

}
