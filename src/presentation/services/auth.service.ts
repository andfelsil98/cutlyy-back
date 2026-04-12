import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { User } from "../../domain/interfaces/user.interface";
import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import type { RegisterDto } from "../auth/dtos/register.dto";
import type { LoginDto } from "../auth/dtos/login.dto";
import { BusinessMembershipService } from "./business-membership.service";
import FirestoreService from "./firestore.service";
import { UserService } from "./user.service";

const BUSINESS_COLLECTION = "Businesses";
const USERS_COLLECTION = "Users";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";

export interface RegisterResult {
  user: User;
  businessMembership: BusinessMembership;
}

export interface LoginResult {
  user: User;
}

export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly businessMembershipService: BusinessMembershipService
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResult> {
    const business =
      dto.businessName != null
        ? await this.findActiveBusinessByName(dto.businessName)
        : null;
    if (dto.businessName != null && business == null) {
      throw CustomError.notFound("No existe un negocio activo con ese nombre");
    }

    const [emailExists, documentExists] = await Promise.all([
      this.userService.existsByEmail(dto.email),
      this.userService.existsByDocument(dto.document),
    ]);
    if (emailExists) {
      throw CustomError.conflict("Ya existe un usuario registrado con este correo");
    }
    if (documentExists) {
      throw CustomError.conflict("Ya existe un usuario registrado con este documento");
    }

    let firebaseUid: string | undefined;
    let userId: string | undefined;
    let membershipId: string | undefined;

    try {
      firebaseUid = await this.createFirebaseAuthUser(dto);

      const user = await this.userService.createUser({
        phone: dto.phone,
        name: dto.name,
        email: dto.email,
        document: dto.document,
        documentTypeName: dto.documentTypeName,
        documentTypeId: dto.documentTypeId,
      });
      userId = user.id;

      const businessMembership = await this.businessMembershipService.create({
        ...(business != null && { businessId: business.id }),
        userId: user.document,
      });
      membershipId = businessMembership.id;

      await FirestoreService.createInSubcollection(USERS_COLLECTION, user.id, "businessMemberships", {
        id: businessMembership.id,
        ...(business != null && { businessId: business.id }),
        membershipId: businessMembership.id,
      });

      return {
        user,
        businessMembership,
      };
    } catch (error) {
      await this.rollbackRegister({
        firebaseUid,
        userId,
        membershipId,
      });
      if (error instanceof CustomError) throw error;
      throw this.mapFirebaseRegisterError(error);
    }
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userService.getByEmail(dto.email);
    if (user == null) {
      // El usuario no existe en nuestra base de datos:
      // eliminar el usuario en Firebase Authentication por correo (getUserByEmail + deleteUser).
      try {
        const firebaseUser = await FirestoreDataBase.getAdmin()
          .auth()
          .getUserByEmail(dto.email);
        await FirestoreDataBase.getAdmin().auth().deleteUser(firebaseUser.uid);
      } catch {
        // Si no existe en Auth o falla la eliminación, igual respondemos que no existe.
      }
      throw CustomError.notFound("El usuario no existe");
    }

    return { user };
  }

  private async findActiveBusinessByName(businessName: string): Promise<Business | null> {
    const businesses = await FirestoreService.getAll<Business>(BUSINESS_COLLECTION, [
      { field: "name", operator: "==", value: businessName },
      { field: "status", operator: "==", value: "ACTIVE" },
    ]);
    return businesses[0] ?? null;
  }

  private async createFirebaseAuthUser(dto: RegisterDto): Promise<string> {
    const auth = FirestoreDataBase.getAdmin().auth();
    try {
      const firebaseUser = await auth.createUser({
        email: dto.email,
        password: dto.password,
        emailVerified: true,
        displayName: dto.name,
      });
      await auth.setCustomUserClaims(firebaseUser.uid, {
        document: dto.document,
      });
      return firebaseUser.uid;
    } catch (error) {
      throw this.mapFirebaseRegisterError(error);
    }
  }

  private async rollbackRegister({
    firebaseUid,
    userId,
    membershipId,
  }: {
    firebaseUid: string | undefined;
    userId: string | undefined;
    membershipId: string | undefined;
  }): Promise<void> {
    const deletions: Promise<unknown>[] = [];

    if (membershipId) {
      deletions.push(
        FirestoreService.delete(BUSINESS_MEMBERSHIPS_COLLECTION, membershipId).catch(() => undefined)
      );
    }
    if (userId) {
      deletions.push(FirestoreService.delete(USERS_COLLECTION, userId).catch(() => undefined));
    }
    if (firebaseUid) {
      deletions.push(FirestoreDataBase.getAdmin().auth().deleteUser(firebaseUid).catch(() => undefined));
    }

    await Promise.all(deletions);
  }

  private mapFirebaseRegisterError(error: unknown): CustomError {
    const code =
      typeof error === "object" &&
      error != null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";

    if (code === "auth/email-already-exists") {
      return CustomError.conflict("Ya existe un usuario registrado con este correo");
    }
    if (code === "auth/invalid-password") {
      return CustomError.badRequest("password inválido para Firebase Authentication");
    }
    if (code === "auth/invalid-email") {
      return CustomError.badRequest("email inválido para Firebase Authentication");
    }
    return CustomError.internalServerError("Error interno del servidor");
  }
}
