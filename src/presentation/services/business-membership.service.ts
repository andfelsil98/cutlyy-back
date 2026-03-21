import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Role } from "../../domain/interfaces/role.interface";
import type { User } from "../../domain/interfaces/user.interface";
import {
  buildPagination,
  type PaginatedResult,
  type PaginationParams,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import FirestoreService from "./firestore.service";
import { RoleService } from "./role.service";
import { UserService } from "./user.service";

const COLLECTION_NAME = "BusinessMemberships";
const BUSINESSES_COLLECTION = "Businesses";
const ROLE_COLLECTION = "Roles";
const USER_COLLECTION = "Users";
const ROOT_SUPER_ADMIN_ID = "WyeIL50oCUFg9PBvB9m9";

export interface CreateBusinessMembershipData {
  businessId: string;
  userId: string;
}

export type BusinessMembershipWithRelations = Omit<
  BusinessMembership,
  "roleId" | "userId"
> & {
  role: Role | null;
  user: User | null;
};

export class BusinessMembershipService {
  constructor(
    private readonly userService?: UserService,
    private readonly roleService?: RoleService
  ) {}

  async getAllMemberships(
    params: PaginationParams & {
      id?: string;
      userId?: string;
      email?: string;
      businessId?: string;
      expandRefs?: boolean;
    }
  ): Promise<PaginatedResult<BusinessMembership | BusinessMembershipWithRelations>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const requestedId =
        params.id != null && params.id.trim() !== ""
          ? params.id.trim()
          : undefined;
      const requestedUserId =
        params.userId != null && params.userId.trim() !== ""
          ? params.userId.trim()
          : undefined;
      const requestedEmail =
        params.email != null && params.email.trim() !== ""
          ? params.email.trim()
          : undefined;
      const requestedBusinessId =
        params.businessId != null && params.businessId.trim() !== ""
          ? params.businessId.trim()
          : undefined;
      const shouldExpandRefs = params.expandRefs === true;

      let effectiveUserId = requestedUserId;

      if (requestedEmail && this.userService) {
        const user = await this.userService.getByEmail(requestedEmail);
        if (!user) {
          return {
            data: [],
            total: 0,
            pagination: buildPagination(page, pageSize, 0),
          };
        }

        if (effectiveUserId && effectiveUserId !== user.id) {
          return {
            data: [],
            total: 0,
            pagination: buildPagination(page, pageSize, 0),
          };
        }

        effectiveUserId = user.id;
      }

      const filters = [
        {
          field: "status" as const,
          operator: "in" as const,
          value: ["ACTIVE", "INACTIVE", "PENDING"],
        },
        ...(requestedId != null
          ? [
              {
                field: "id" as const,
                operator: "==" as const,
                value: requestedId,
              },
            ]
          : []),
        ...(effectiveUserId != null
          ? [
              {
                field: "userId" as const,
                operator: "==" as const,
                value: effectiveUserId,
              },
            ]
          : []),
        ...(requestedBusinessId != null
          ? [
              {
                field: "businessId" as const,
                operator: "==" as const,
                value: requestedBusinessId,
              },
            ]
          : []),
      ];

      const result = await FirestoreService.getAllPaginated<BusinessMembership>(
        COLLECTION_NAME,
        { page, pageSize },
        filters
      );
      const normalizedMemberships = result.data.map((membership) =>
        this.normalizeMembership(membership)
      );
      if (!shouldExpandRefs) {
        return {
          ...result,
          data: normalizedMemberships,
        };
      }

      const data = await this.attachRelations(normalizedMemberships);
      return {
        ...result,
        data,
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async attachRelations(
    memberships: BusinessMembership[]
  ): Promise<BusinessMembershipWithRelations[]> {
    if (memberships.length === 0) {
      return [];
    }

    const uniqueRoleIds = Array.from(
      new Set(
        memberships
          .map((membership) => membership.roleId?.trim() ?? "")
          .filter((roleId) => roleId !== "")
      )
    );
    const uniqueUserIds = Array.from(
      new Set(
        memberships
          .map((membership) => membership.userId.trim())
          .filter((userId) => userId !== "")
      )
    );

    const [rolesById, usersByMembershipUserId] = await Promise.all([
      this.getRolesById(uniqueRoleIds),
      this.getUsersByMembershipUserId(uniqueUserIds),
    ]);

    return memberships.map((membership) => {
      const roleKey = membership.roleId?.trim() ?? "";
      const userKey = membership.userId.trim();
      const { roleId: _roleId, userId: _userId, ...membershipWithoutRelationIds } =
        membership;

      return {
        ...membershipWithoutRelationIds,
        role: roleKey !== "" ? (rolesById.get(roleKey) ?? null) : null,
        user: userKey !== "" ? (usersByMembershipUserId.get(userKey) ?? null) : null,
      };
    });
  }

  private async getRolesById(roleIds: string[]): Promise<Map<string, Role>> {
    if (roleIds.length === 0) {
      return new Map();
    }

    const CHUNK_SIZE = 30;
    const chunks: string[][] = [];
    for (let i = 0; i < roleIds.length; i += CHUNK_SIZE) {
      chunks.push(roleIds.slice(i, i + CHUNK_SIZE));
    }

    const results = await Promise.all(
      chunks.map((chunk) =>
        FirestoreService.getAll<Role>(ROLE_COLLECTION, [
          { field: "id", operator: "in", value: chunk },
        ])
      )
    );

    const rolesMap = new Map<string, Role>();
    for (const role of results.flat()) {
      rolesMap.set(role.id, role);
    }
    return rolesMap;
  }

  private async getUsersByMembershipUserId(
    userIds: string[]
  ): Promise<Map<string, User>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const CHUNK_SIZE = 30;
    const chunks: string[][] = [];
    for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
      chunks.push(userIds.slice(i, i + CHUNK_SIZE));
    }

    // Batch fetch por id de Firestore
    const byIdResults = await Promise.all(
      chunks.map((chunk) =>
        FirestoreService.getAll<User>(USER_COLLECTION, [
          { field: "id", operator: "in", value: chunk },
        ])
      )
    );

    const usersMap = new Map<string, User>();
    const foundIds = new Set<string>();
    for (const user of byIdResults.flat()) {
      usersMap.set(user.id, user);
      foundIds.add(user.id);
    }

    // Compatibilidad con membresías antiguas que guardan documento en userId.
    const missingUserIds = userIds.filter((uid) => !foundIds.has(uid));
    if (missingUserIds.length > 0) {
      const missingChunks: string[][] = [];
      for (let i = 0; i < missingUserIds.length; i += CHUNK_SIZE) {
        missingChunks.push(missingUserIds.slice(i, i + CHUNK_SIZE));
      }

      const byDocResults = await Promise.all(
        missingChunks.map((chunk) =>
          FirestoreService.getAll<User>(USER_COLLECTION, [
            { field: "document", operator: "in", value: chunk },
          ])
        )
      );

      const usersByDocument = new Map<string, User>();
      for (const user of byDocResults.flat()) {
        usersByDocument.set(user.document, user);
      }

      for (const membershipUserId of missingUserIds) {
        const user = usersByDocument.get(membershipUserId);
        if (user) {
          usersMap.set(membershipUserId, user);
        }
      }
    }

    return usersMap;
  }

  async create(data: CreateBusinessMembershipData): Promise<BusinessMembership> {
    try {
      const doc = {
        businessId: data.businessId,
        userId: data.userId,
        isEmployee: false,
        roleId: null as string | null,
        status: "PENDING" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };
      const result = await FirestoreService.create(COLLECTION_NAME, doc);
      return this.normalizeMembership(result as BusinessMembership);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async getMembershipById(
    id: string
  ): Promise<BusinessMembership> {
    const memberships = await FirestoreService.getAll<BusinessMembership>(
      COLLECTION_NAME,
      [{ field: "id", operator: "==", value: id }]
    );
    if (memberships.length === 0) {
      throw CustomError.notFound("No existe una membresía con este id");
    }
    return this.normalizeMembership(memberships[0]!);
  }

  async toggleStatus(id: string): Promise<BusinessMembership> {
    try {
      const membership = await this.getMembershipById(id);

      if (membership.status === "DELETED") {
        throw CustomError.badRequest(
          "No se puede modificar una membresía eliminada"
        );
      }

      let newStatus: "ACTIVE" | "INACTIVE";
      switch (membership.status) {
        case "ACTIVE":
          newStatus = "INACTIVE";
          break;
        case "INACTIVE":
        case "PENDING":
          newStatus = "ACTIVE";
          break;
        default:
          newStatus = "ACTIVE";
          break;
      }

      if (newStatus === "ACTIVE") {
        if (!membership.roleId || membership.roleId.trim() === "") {
          throw CustomError.badRequest(
            "No se puede activar una membresía sin un rol asociado"
          );
        }
      }

      const payload = {
        status: newStatus,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };
      await FirestoreService.update(COLLECTION_NAME, id, payload);
      return await this.getMembershipById(id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async toggleIsEmployee(id: string): Promise<BusinessMembership> {
    try {
      const membership = await this.getMembershipById(id);

      if (membership.status === "DELETED") {
        throw CustomError.badRequest(
          "No se puede modificar una membresía eliminada"
        );
      }

      const nextIsEmployee = !membership.isEmployee;
      const userDocument = await this.resolveMembershipUserDocument(membership.userId);

      if (nextIsEmployee && membership.status !== "ACTIVE") {
        throw CustomError.badRequest(
          "Solo se puede marcar como empleado una membresía ACTIVE"
        );
      }

      const business = await FirestoreService.getById<Business>(
        BUSINESSES_COLLECTION,
        membership.businessId
      );
      const nextEmployees = this.buildNextEmployeesList(
        business.employees,
        userDocument,
        nextIsEmployee
      );
      const updatedAt = FirestoreDataBase.generateTimeStamp();

      const db = FirestoreDataBase.getDB();
      const batch = db.batch();
      const membershipPayload: Record<string, unknown> = {
        isEmployee: nextIsEmployee,
        updatedAt,
      };
      batch.update(db.collection(COLLECTION_NAME).doc(id), membershipPayload);
      batch.update(db.collection(BUSINESSES_COLLECTION).doc(membership.businessId), {
        employees: nextEmployees,
        updatedAt,
      });
      await batch.commit();

      return await this.getMembershipById(id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async assignRole(
    membershipId: string,
    roleId: string,
    opts: {
      businessId: string;
      requesterDocument: string;
    }
  ): Promise<BusinessMembership> {
    try {
      const targetMembership = await this.getMembershipById(membershipId);
      const businessId = opts.businessId.trim();
      const requesterDocument = opts.requesterDocument.trim();

      if (targetMembership.businessId !== businessId) {
        throw CustomError.badRequest(
          "El businessId del header no coincide con la membresía a modificar"
        );
      }

      const requesterMembership =
        await this.getMembershipByBusinessAndRequesterDocument(
          businessId,
          requesterDocument
        );
      if (!requesterMembership || requesterMembership.status === "DELETED") {
        throw CustomError.forbidden(
          "No tienes membresía vigente en el negocio indicado para asignar roles"
        );
      }

      // Validar rol
      const roles = await FirestoreService.getAll<Role>(ROLE_COLLECTION, [
        { field: "id", operator: "==", value: roleId },
      ]);
      if (roles.length === 0) {
        throw CustomError.notFound("No existe un rol con este id");
      }

      const isDemotingSuperAdmin =
        targetMembership.roleId === ROOT_SUPER_ADMIN_ID &&
        roleId !== ROOT_SUPER_ADMIN_ID;

      if (isDemotingSuperAdmin) {
        await this.ensureAnotherSuperAdminExists(businessId, targetMembership.id);
      }

      const payload = {
        roleId,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };
      await FirestoreService.update(COLLECTION_NAME, membershipId, payload);
      return await this.getMembershipById(membershipId);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async getMembershipByBusinessAndRequesterDocument(
    businessId: string,
    requesterDocument: string
  ): Promise<BusinessMembership | null> {
    const memberships = await FirestoreService.getAll<BusinessMembership>(
      COLLECTION_NAME,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    let requesterUserId: string | undefined;
    if (this.userService) {
      const requesterUser = await this.userService.getByDocument(requesterDocument);
      requesterUserId = requesterUser?.id;
    }

    return (
      memberships.find(
        (membership) =>
          membership.userId === requesterDocument ||
          (requesterUserId != null && membership.userId === requesterUserId)
      ) ?? null
    );
  }

  private async ensureAnotherSuperAdminExists(
    businessId: string,
    excludedMembershipId: string
  ): Promise<void> {
    const memberships = await FirestoreService.getAll<BusinessMembership>(
      COLLECTION_NAME,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const anotherSuperAdminExists = memberships.some(
      (membership) =>
        membership.id !== excludedMembershipId &&
        membership.status !== "DELETED" &&
        membership.roleId === ROOT_SUPER_ADMIN_ID
    );

    if (!anotherSuperAdminExists) {
      throw CustomError.conflict(
        "No se puede realizar esta acción. Cada negocio debe tener al menos un SUPER_ADMIN."
      );
    }
  }

  private normalizeMembership(membership: BusinessMembership): BusinessMembership {
    return {
      ...membership,
      isEmployee: membership.isEmployee === true,
    };
  }

  private async resolveMembershipUserDocument(membershipUserId: string): Promise<string> {
    const normalizedMembershipUserId = membershipUserId.trim();
    if (normalizedMembershipUserId === "") {
      throw CustomError.badRequest("La membresía no tiene un userId válido");
    }

    let user: User | null = null;

    if (this.userService) {
      user = await this.userService.getByDocument(normalizedMembershipUserId);
      if (!user) {
        user = await this.userService.getById(normalizedMembershipUserId);
      }
    }

    if (!user) {
      const [usersByDocument, usersById] = await Promise.all([
        FirestoreService.getAll<User>(USER_COLLECTION, [
          { field: "document", operator: "==", value: normalizedMembershipUserId },
        ]),
        FirestoreService.getAll<User>(USER_COLLECTION, [
          { field: "id", operator: "==", value: normalizedMembershipUserId },
        ]),
      ]);
      user = usersByDocument[0] ?? usersById[0] ?? null;
    }

    if (!user || user.document.trim() === "") {
      throw CustomError.notFound(
        "No existe un usuario válido para la membresía que se intenta modificar"
      );
    }

    return user.document.trim();
  }

  private buildNextEmployeesList(
    currentEmployees: string[] | undefined,
    userDocument: string,
    shouldInclude: boolean
  ): string[] {
    const normalizedCurrentEmployees = (currentEmployees ?? [])
      .map((employeeDocument) => employeeDocument.trim())
      .filter((employeeDocument) => employeeDocument !== "");
    const employeesSet = new Set(normalizedCurrentEmployees);

    if (shouldInclude) {
      employeesSet.add(userDocument);
    } else {
      employeesSet.delete(userDocument);
    }

    return Array.from(employeesSet);
  }
}
