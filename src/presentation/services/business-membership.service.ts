import { FieldValue } from "firebase-admin/firestore";
import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import {
  isBusinessRoleType,
  isGlobalRoleType,
} from "../../domain/constants/access-control.constants";
import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import {
  BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES,
  type BusinessMembership,
  type BusinessMembershipQueryableStatus,
} from "../../domain/interfaces/business-membership.interface";
import type { Role } from "../../domain/interfaces/role.interface";
import type { User } from "../../domain/interfaces/user.interface";
import {
  buildPagination,
  type PaginatedResult,
  type PaginationParams,
  MAX_PAGE_SIZE,
} from "../../domain/interfaces/pagination.interface";
import { isAdminProtectedRole } from "../../domain/constants/protected-role.constants";
import { BusinessUsageLimitService } from "./business-usage-limit.service";
import FirestoreService from "./firestore.service";
import { RoleService } from "./role.service";
import { SchedulingIntegrityService } from "./scheduling-integrity.service";
import { UserService } from "./user.service";

const COLLECTION_NAME = "BusinessMemberships";
const BUSINESSES_COLLECTION = "Businesses";
const BRANCHES_COLLECTION = "Branches";
const ROLE_COLLECTION = "Roles";
const USER_COLLECTION = "Users";

export interface CreateBusinessMembershipData {
  businessId?: string;
  userId: string;
}

export interface CreatePendingMembershipByDocumentData {
  businessId?: string;
  document: string;
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
    private readonly roleService?: RoleService,
    private readonly schedulingIntegrityService: SchedulingIntegrityService =
      new SchedulingIntegrityService(),
    private readonly businessUsageLimitService: BusinessUsageLimitService =
      new BusinessUsageLimitService()
  ) {}

  async getAllMemberships(
    params: PaginationParams & {
      id?: string;
      userId?: string;
      email?: string;
      businessId?: string;
      branchId?: string;
      roleId?: string;
      status?: BusinessMembershipQueryableStatus;
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
      const requestedBranchId =
        params.branchId != null && params.branchId.trim() !== ""
          ? params.branchId.trim()
          : undefined;
      const requestedRoleId =
        params.roleId != null && params.roleId.trim() !== ""
          ? params.roleId.trim()
          : undefined;
      const requestedStatusRaw =
        typeof params.status === "string" && params.status.trim() !== ""
          ? params.status.trim().toUpperCase()
          : undefined;
      const requestedStatus =
        requestedStatusRaw as BusinessMembershipQueryableStatus | undefined;
      const shouldExpandRefs = params.expandRefs === true;

      if (
        requestedStatus != null &&
        !BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES.includes(requestedStatus)
      ) {
        throw CustomError.badRequest(
          "El estado debe ser activo, inactivo o pendiente cuando se proporcione"
        );
      }

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
        ...(requestedStatus != null
          ? [
              {
                field: "status" as const,
                operator: "==" as const,
                value: requestedStatus,
              },
            ]
          : [
              {
                field: "status" as const,
                operator: "in" as const,
                value: BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES,
              },
            ]),
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
        ...(requestedBranchId != null
          ? [
              {
                field: "branchId" as const,
                operator: "==" as const,
                value: requestedBranchId,
              },
            ]
          : []),
        ...(requestedRoleId != null
          ? [
              {
                field: "roleId" as const,
                operator: "==" as const,
                value: requestedRoleId,
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
        businessId: data.businessId?.trim() ? data.businessId.trim() : null,
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

  async createPendingByDocument(
    data: CreatePendingMembershipByDocumentData
  ): Promise<BusinessMembership> {
    try {
      const document = data.document.trim();
      const explicitBusinessId = data.businessId?.trim() ?? "";

      const user = await this.findUserByDocument(document);

      if (!user) {
        throw CustomError.notFound(
          "No existe un usuario con este número de documento"
        );
      }

      const now = FirestoreDataBase.generateTimeStamp();
      const businessId = explicitBusinessId;
      if (businessId !== "") {
        const business = await this.getBusinessById(businessId);
        if (business.status === "DELETED") {
          throw CustomError.badRequest(
            "No se puede crear una membresía en un negocio eliminado"
          );
        }

        const existingMemberships = await this.getMembershipsByBusinessAndUser(
          businessId,
          user
        );
        const activeMembership = existingMemberships.find(
          (membership) => membership.status !== "DELETED"
        );

        if (activeMembership) {
          throw CustomError.conflict(
            "Ya existe una membresía registrada para este usuario en el negocio indicado"
          );
        }

        const reusableMembership = existingMemberships[0] ?? null;
        const membershipId = reusableMembership?.id;

        if (membershipId) {
          await FirestoreService.update(COLLECTION_NAME, membershipId, {
            businessId,
            userId: user.document,
            isEmployee: false,
            roleId: null,
            status: "PENDING" as const,
            branchId: FieldValue.delete(),
            deletedAt: null,
            updatedAt: now,
          });
        } else {
          const createdMembership = await FirestoreService.create(COLLECTION_NAME, {
            businessId,
            userId: user.document,
            isEmployee: false,
            roleId: null as string | null,
            status: "PENDING" as const,
            createdAt: now,
          });

          await this.ensureUserMembershipLink(user.id, createdMembership.id, businessId);
          return this.normalizeMembership(createdMembership as BusinessMembership);
        }

        await this.ensureUserMembershipLink(user.id, membershipId, businessId);
        return await this.getMembershipById(membershipId);
      }

      const globalMemberships = await this.getGlobalMembershipsByUser(user);
      const activeGlobalMembership = globalMemberships.find(
        (membership) => membership.status !== "DELETED"
      );
      if (activeGlobalMembership) {
        throw CustomError.conflict(
          "Ya existe una membresía global registrada para este usuario"
        );
      }

      const reusableGlobalMembership = globalMemberships[0] ?? null;
      const globalMembershipId = reusableGlobalMembership?.id;
      if (globalMembershipId) {
        await FirestoreService.update(COLLECTION_NAME, globalMembershipId, {
          businessId: null,
          userId: user.document,
          isEmployee: false,
          roleId: null,
          status: "PENDING" as const,
          branchId: FieldValue.delete(),
          deletedAt: null,
          updatedAt: now,
        });
        await this.ensureUserMembershipLink(user.id, globalMembershipId);
        return await this.getMembershipById(globalMembershipId);
      }

      const createdGlobalMembership = await FirestoreService.create(COLLECTION_NAME, {
        businessId: null,
        userId: user.document,
        isEmployee: false,
        roleId: null as string | null,
        status: "PENDING" as const,
        createdAt: now,
      });

      await this.ensureUserMembershipLink(user.id, createdGlobalMembership.id);
      return this.normalizeMembership(createdGlobalMembership as BusinessMembership);
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

  async getById(id: string): Promise<BusinessMembership> {
    return this.getMembershipById(id);
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
      } else {
        await this.ensureBusinessRetainsAdminMembership({
          membership,
          nextStatus: newStatus,
          errorMessage:
            "Cada negocio debe tener al menos una persona activa con el rol administrador. No puedes inactivar al único administrador del negocio.",
        });

        if (membership.isEmployee === true) {
          const employeeIdentifiers = await this.resolveMembershipUserIdentifiers(
            membership.userId
          );
          await this.schedulingIntegrityService.ensureEmployeeCanBeDeleted(
            employeeIdentifiers
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
      const employeeIdentifiers = await this.resolveMembershipUserIdentifiers(
        membership.userId
      );
      const userDocument = employeeIdentifiers[0]!;

      if (nextIsEmployee && membership.status !== "ACTIVE") {
        throw CustomError.badRequest(
          "Solo se puede marcar como empleado una membresía activa"
        );
      }

      if (!nextIsEmployee) {
        await this.schedulingIntegrityService.ensureEmployeeCanBeDeleted(
          employeeIdentifiers
        );
      }

      if (!membership.businessId?.trim()) {
        throw CustomError.badRequest(
          "No se puede cambiar isEmployee en una membresía global"
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
      if (nextIsEmployee) {
        membershipPayload.branchId =
          typeof membership.branchId === "string" && membership.branchId.trim() !== ""
            ? membership.branchId.trim()
            : null;
      } else {
        membershipPayload.branchId = FieldValue.delete();
      }
      batch.update(db.collection(COLLECTION_NAME).doc(id), membershipPayload);
      batch.update(db.collection(BUSINESSES_COLLECTION).doc(membership.businessId), {
        employees: nextEmployees,
        updatedAt,
      });
      if (nextIsEmployee) {
        await this.businessUsageLimitService.consume(membership.businessId, "employees", 1);
      }
      try {
        await batch.commit();
      } catch (error) {
        if (nextIsEmployee) {
          await this.businessUsageLimitService.release(membership.businessId, "employees", 1).catch(() => undefined);
        }
        throw error;
      }

      if (!nextIsEmployee) {
        await this.businessUsageLimitService.release(membership.businessId, "employees", 1);
      }

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
      businessId?: string;
      requesterDocument: string;
    }
  ): Promise<BusinessMembership> {
    try {
      const targetMembership = await this.getMembershipById(membershipId);
      const businessId = opts.businessId?.trim() ?? "";
      const requesterDocument = opts.requesterDocument.trim();

      const targetBusinessId = targetMembership.businessId?.trim() ?? "";
      if (targetBusinessId !== "") {
        if (targetBusinessId !== businessId) {
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
      }

      const roles = await FirestoreService.getAll<Role>(ROLE_COLLECTION, [
        { field: "id", operator: "==", value: roleId },
      ]);
      if (roles.length === 0) {
        throw CustomError.notFound("No existe un rol con este id");
      }
      const role = roles[0]!;

      await this.ensureBusinessRetainsAdminMembership({
        membership: targetMembership,
        nextRole: role,
        nextStatus: targetMembership.status,
        errorMessage:
          "Cada negocio debe tener al menos una persona activa con el rol administrador. No puedes cambiar el rol del único administrador del negocio.",
      });

      if (targetBusinessId === "") {
        if (!isGlobalRoleType(role.type)) {
          throw CustomError.badRequest(
            "Solo se puede asignar un rol global a una membresía global"
          );
        }
      } else {
        if (!isBusinessRoleType(role.type)) {
          throw CustomError.badRequest(
            "Solo se puede asignar un rol de negocio o multinegocio a una membresía de negocio"
          );
        }
        if (role.type === "BUSINESS" && role.businessId?.trim() !== targetBusinessId) {
          throw CustomError.badRequest(
            "No se puede asignar un rol de negocio de otro negocio"
          );
        }
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

  async assignBranch(
    membershipId: string,
    branchId: string
  ): Promise<BusinessMembership> {
    try {
      const membership = await this.getMembershipById(membershipId);

      if (membership.status !== "ACTIVE") {
        throw CustomError.badRequest(
          "Solo se puede asignar sede a una membresía activa"
        );
      }

      if (!membership.businessId?.trim()) {
        throw CustomError.badRequest(
          "No se puede asignar sede a una membresía global"
        );
      }

      if (membership.isEmployee !== true) {
        throw CustomError.badRequest(
          "Solo se puede asignar sede a una membresía con isEmployee=true"
        );
      }

      const branch = await FirestoreService.getById<Branch>(
        BRANCHES_COLLECTION,
        branchId
      );

      if (branch.status === "DELETED") {
        throw CustomError.badRequest(
          "No se puede asignar una sede eliminada a la membresía"
        );
      }

      if (branch.businessId !== membership.businessId) {
        throw CustomError.badRequest(
          "La sede no pertenece al mismo negocio de la membresía"
        );
      }

      await FirestoreService.update(COLLECTION_NAME, membershipId, {
        branchId: branch.id,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

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

  private normalizeMembership(membership: BusinessMembership): BusinessMembership {
    const {
      branchId: rawBranchId,
      businessId: rawBusinessId,
      ...membershipWithoutBranch
    } = membership;
    const normalizedBusinessId =
      typeof rawBusinessId === "string" && rawBusinessId.trim() !== ""
        ? rawBusinessId.trim()
        : null;
    const normalizedBranchId =
      typeof rawBranchId === "string" && rawBranchId.trim() !== ""
        ? rawBranchId.trim()
        : null;

    if (membership.isEmployee === true) {
      return {
        ...membershipWithoutBranch,
        businessId: normalizedBusinessId,
        isEmployee: true,
        branchId: normalizedBranchId,
      };
    }

    return {
      ...membershipWithoutBranch,
      businessId: normalizedBusinessId,
      isEmployee: false,
    };
  }

  private async getRoleById(roleId: string): Promise<Role | null> {
    const normalizedRoleId = roleId.trim();
    if (normalizedRoleId === "") return null;

    const roles = await FirestoreService.getAll<Role>(ROLE_COLLECTION, [
      { field: "id", operator: "==", value: normalizedRoleId },
    ]);
    return roles[0] ?? null;
  }

  private async ensureBusinessRetainsAdminMembership(input: {
    membership: BusinessMembership;
    nextRole?: Role | null;
    nextStatus: BusinessMembership["status"];
    errorMessage: string;
  }): Promise<void> {
    const businessId = input.membership.businessId?.trim() ?? "";
    if (businessId === "") return;
    if (input.membership.status !== "ACTIVE") return;

    const currentRoleId = input.membership.roleId?.trim() ?? "";
    if (currentRoleId === "") return;

    const currentRole = await this.getRoleById(currentRoleId);
    if (!currentRole || !isAdminProtectedRole(currentRole)) return;

    const willRemainAdmin =
      input.nextStatus === "ACTIVE" &&
      input.nextRole != null &&
      isAdminProtectedRole(input.nextRole);
    if (willRemainAdmin) return;

    const activeAdminMemberships = await FirestoreService.getAll<BusinessMembership>(
      COLLECTION_NAME,
      [
        { field: "businessId", operator: "==", value: businessId },
        { field: "roleId", operator: "==", value: currentRole.id },
        { field: "status", operator: "==", value: "ACTIVE" },
      ]
    );

    const hasAnotherActiveAdmin = activeAdminMemberships.some(
      (membership) => membership.id !== input.membership.id
    );
    if (!hasAnotherActiveAdmin) {
      throw CustomError.badRequest(input.errorMessage);
    }
  }

  private async resolveMembershipUser(membershipUserId: string): Promise<User> {
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

    return user;
  }

  private async resolveMembershipUserIdentifiers(
    membershipUserId: string
  ): Promise<string[]> {
    const user = await this.resolveMembershipUser(membershipUserId);
    return Array.from(new Set([user.document.trim(), user.id.trim()])).filter(
      (identifier) => identifier !== ""
    );
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

  private async getBusinessById(businessId: string): Promise<Business> {
    const businesses = await FirestoreService.getAll<Business>(
      BUSINESSES_COLLECTION,
      [{ field: "id", operator: "==", value: businessId }]
    );

    if (businesses.length === 0) {
      throw CustomError.notFound("No existe un negocio con este id");
    }

    return businesses[0]!;
  }

  private async findUserByDocument(document: string): Promise<User | null> {
    const normalizedDocument = document.trim();
    if (normalizedDocument === "") {
      return null;
    }

    if (this.userService) {
      return await this.userService.getByDocument(normalizedDocument);
    }

    const users = await FirestoreService.getAll<User>(USER_COLLECTION, [
      { field: "document", operator: "==", value: normalizedDocument },
    ]);
    return users[0] ?? null;
  }

  private async getMembershipsByBusinessAndUser(
    businessId: string,
    user: User
  ): Promise<BusinessMembership[]> {
    const [membershipsByDocument, membershipsById] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(COLLECTION_NAME, [
        { field: "businessId", operator: "==", value: businessId },
        { field: "userId", operator: "==", value: user.document },
      ]),
      FirestoreService.getAll<BusinessMembership>(COLLECTION_NAME, [
        { field: "businessId", operator: "==", value: businessId },
        { field: "userId", operator: "==", value: user.id },
      ]),
    ]);

    const membershipsMap = new Map<string, BusinessMembership>();
    membershipsByDocument.forEach((membership) =>
      membershipsMap.set(membership.id, this.normalizeMembership(membership))
    );
    membershipsById.forEach((membership) =>
      membershipsMap.set(membership.id, this.normalizeMembership(membership))
    );

    return Array.from(membershipsMap.values());
  }

  private async getGlobalMembershipsByUser(user: User): Promise<BusinessMembership[]> {
    const [membershipsByDocument, membershipsById] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(COLLECTION_NAME, [
        { field: "businessId", operator: "==", value: null },
        { field: "userId", operator: "==", value: user.document },
      ]),
      FirestoreService.getAll<BusinessMembership>(COLLECTION_NAME, [
        { field: "businessId", operator: "==", value: null },
        { field: "userId", operator: "==", value: user.id },
      ]),
    ]);

    const membershipsMap = new Map<string, BusinessMembership>();
    membershipsByDocument.forEach((membership) =>
      membershipsMap.set(membership.id, this.normalizeMembership(membership))
    );
    membershipsById.forEach((membership) =>
      membershipsMap.set(membership.id, this.normalizeMembership(membership))
    );

    return Array.from(membershipsMap.values());
  }

  private async ensureUserMembershipLink(
    userId: string,
    membershipId: string,
    businessId?: string
  ): Promise<void> {
    await FirestoreService.createInSubcollection(
      USER_COLLECTION,
      userId,
      "businessMemberships",
      {
        id: membershipId,
        membershipId,
        ...(businessId != null && businessId.trim() !== "" && { businessId }),
      }
    );
  }
}
