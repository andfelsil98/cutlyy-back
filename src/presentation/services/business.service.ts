import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type {
  Business,
  CreateBusinessCompleteResult,
} from "../../domain/interfaces/business.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import type { Service } from "../../domain/interfaces/service.interface";
import type { User } from "../../domain/interfaces/user.interface";
import type { PaginatedResult, PaginationParams } from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import { normalizeConsecutivePrefix } from "../../domain/utils/booking-consecutive.utils";
import { logger } from "../../infrastructure/logger/logger";
import type { CreateBusinessDto } from "../business/dtos/create-business.dto";
import type { CreateBusinessCompleteDto } from "../business/dtos/create-business-complete.dto";
import type { UpdateBusinessDto } from "../business/dtos/update-business.dto";
import type { CreateBranchItemDto } from "../branch/dtos/create-branch.dto";
import type { CreateServiceItemDto } from "../service/dtos/create-service.dto";
import type { AppointmentStatusTaskScheduler } from "./appointment-status-task-scheduler.service";
import type { BranchService } from "./branch.service";
import FirestoreService from "./firestore.service";
import type { ServiceService } from "./service.service";
import type { UserService } from "./user.service";

const COLLECTION_NAME = "Businesses";
const SERVICES_COLLECTION = "Services";
const BRANCHES_COLLECTION = "Branches";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";
const APPOINTMENTS_COLLECTION = "Appointments";
const BOOKINGS_COLLECTION = "Bookings";
const METRICS_COLLECTION = "Metrics";
const REVIEWS_COLLECTION = "Reviews";
const ROLES_COLLECTION = "Roles";
const USERS_COLLECTION = "Users";
const USER_BUSINESS_MEMBERSHIPS_SUBCOLLECTION = "businessMemberships";
const ROLE_PERMISSIONS_SUBCOLLECTION = "Permissions";
const ROOT_OWNER_ROLE_ID = "kr3ECTOcAGHnsbvDAr4y";
const ROOT_SUPER_ADMIN_ID = "WyeIL50oCUFg9PBvB9m9";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim() ?? "")
        .filter((value) => value !== "")
    )
  );
}

interface FirestoreEntityWithId {
  id: string;
}

interface AppointmentDeletionRecord extends FirestoreEntityWithId {
  employeeId?: string;
}

interface FirestoreMembershipLinkDoc {
  businessId?: string;
  membershipId?: string;
}

interface BusinessDeletionContext {
  appointmentIds: string[];
  bookingIds: string[];
  branchIds: string[];
  membershipIds: string[];
  metricIds: string[];
  reviewIds: string[];
  roleIds: string[];
  serviceIds: string[];
  users: User[];
}

export class BusinessService {
  constructor(
    private readonly serviceService?: ServiceService,
    private readonly branchService?: BranchService,
    private readonly userService?: UserService,
    private readonly appointmentStatusTaskScheduler?: AppointmentStatusTaskScheduler
  ) {}

  async getAllBusinesses(
    params: PaginationParams & { id?: string; slug?: string; consecutivePrefix?: string }
  ): Promise<PaginatedResult<Business>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const filters = [
        {
          field: "status" as const,
          operator: "in" as const,
          value: ["ACTIVE", "INACTIVE", "PENDING"],
        },
        ...(params.id != null && params.id.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.id.trim() }]
          : []),
        ...(params.slug != null && params.slug.trim() !== ""
          ? [{ field: "slug" as const, operator: "==" as const, value: params.slug.trim().toLowerCase() }]
          : []),
        ...(params.consecutivePrefix != null && params.consecutivePrefix.trim() !== ""
          ? [
              {
                field: "consecutivePrefix" as const,
                operator: "==" as const,
                value: normalizeConsecutivePrefix(params.consecutivePrefix),
              },
            ]
          : []),
      ];
      const result = await FirestoreService.getAllPaginated<Business>(
        COLLECTION_NAME,
        {
          page,
          pageSize,
        },
        filters
      );
      return {
        ...result,
        data: result.data.map((business) => this.normalizeBusiness(business)),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createBusiness(dto: CreateBusinessDto): Promise<Business> {
    try {
      const existing = await FirestoreService.getAll<Business>(COLLECTION_NAME, [
        { field: "status", operator: "in", value: ["ACTIVE", "INACTIVE", "PENDING"] },
      ]);
      const incomingNameKey = toNameKey(dto.name);
      const duplicated = existing.some((business) => toNameKey(business.name) === incomingNameKey);
      if (duplicated) {
        throw CustomError.conflict("Ya existe un negocio con este nombre");
      }
      const businessWithSameConsecutivePrefix = await FirestoreService.getAll<Business>(
        COLLECTION_NAME,
        [
          {
            field: "consecutivePrefix",
            operator: "==",
            value: normalizeConsecutivePrefix(dto.consecutivePrefix),
          },
        ]
      );
      if (businessWithSameConsecutivePrefix.length > 0) {
        throw CustomError.conflict("Ya existe un negocio con este consecutivePrefix");
      }
      const data = {
        name: dto.name,
        type: dto.type,
        slug: dto.slug,
        consecutivePrefix: dto.consecutivePrefix,
        employees: [] as string[],
        logoUrl: dto.logoUrl ?? "",
        status: "ACTIVE" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };
      const result = await FirestoreService.create(COLLECTION_NAME, data);
      return this.normalizeBusiness(result);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createBusinessComplete(
    dto: CreateBusinessCompleteDto,
    opts: { creatorDocument: string }
  ): Promise<CreateBusinessCompleteResult> {
    try {
      const business = await this.createBusiness({
        name: dto.name,
        type: dto.type,
        slug: dto.slug,
        consecutivePrefix: dto.consecutivePrefix,
        ...(dto.logoUrl !== undefined && dto.logoUrl !== "" && { logoUrl: dto.logoUrl }),
      });

      await this.ensureCreatorMembership(business.id, opts.creatorDocument);

      const requestedServices = dto.services ?? [];
      let services: Service[] = [];
      if (requestedServices.length > 0 && this.serviceService) {
        services = await this.serviceService.createServices({
          businessId: business.id,
          services: requestedServices,
        });
      }

      const requestedBranches = dto.branches ?? [];
      let branches: Branch[] = [];
      if (requestedBranches.length > 0 && this.branchService) {
        branches = await this.branchService.createBranches({
          businessId: business.id,
          branches: requestedBranches,
        });
      }

      return { business, services, branches };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updateBusiness(id: string, dto: UpdateBusinessDto): Promise<Business> {
    try {
      await FirestoreService.getById<Business>(COLLECTION_NAME, id);

      if (dto.name !== undefined) {
        const withSameName = await FirestoreService.getAll<Business>(
          COLLECTION_NAME,
          [{ field: "status", operator: "in", value: ["ACTIVE", "INACTIVE", "PENDING"] }]
        );
        const incomingNameKey = toNameKey(dto.name);
        const otherWithSameName = withSameName.filter(
          (b) => b.id !== id && toNameKey(b.name) === incomingNameKey
        );
        if (otherWithSameName.length > 0) {
          throw CustomError.conflict("Ya existe un negocio con este nombre");
        }
      }
      if (dto.consecutivePrefix !== undefined) {
        const businessesWithSameConsecutivePrefix = await FirestoreService.getAll<Business>(
          COLLECTION_NAME,
          [
            {
              field: "consecutivePrefix",
              operator: "==",
              value: normalizeConsecutivePrefix(dto.consecutivePrefix),
            },
          ]
        );
        const otherBusinessWithSameConsecutivePrefix =
          businessesWithSameConsecutivePrefix.filter((business) => business.id !== id);
        if (otherBusinessWithSameConsecutivePrefix.length > 0) {
          throw CustomError.conflict(
            "Ya existe un negocio con este consecutivePrefix"
          );
        }
      }

      const payload: Record<string, unknown> = {
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };
      if (dto.name !== undefined) payload.name = dto.name;
      if (dto.type !== undefined) payload.type = dto.type;
      if (dto.consecutivePrefix !== undefined) {
        payload.consecutivePrefix = dto.consecutivePrefix;
      }
      if (dto.logoUrl !== undefined) payload.logoUrl = dto.logoUrl;
      if (dto.slug !== undefined) payload.slug = dto.slug;

      await FirestoreService.update(COLLECTION_NAME, id, payload);

      if (dto.services !== undefined) {
        await this.syncServices(id, dto.services);
      }
      if (dto.branches !== undefined) {
        await this.syncBranches(id, dto.branches);
      }

      return this.normalizeBusiness(
        await FirestoreService.getById<Business>(COLLECTION_NAME, id)
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteBusiness(
    id: string,
    opts: { actorDocument: string }
  ): Promise<Business> {
    try {
      const business = await FirestoreService.getById<Business>(COLLECTION_NAME, id);
      const actorDocument = opts.actorDocument.trim();
      if (actorDocument === "") {
        throw CustomError.badRequest(
          "No se pudo resolver el documento del actor que elimina el negocio"
        );
      }

      const payload: Record<string, unknown> = {};
      if (business.status !== "DELETED") {
        payload.status = "DELETED" as const;
      }
      if (business.deletedAt == null) {
        payload.deletedAt = FirestoreDataBase.generateTimeStamp();
      }
      if (business.deletedBy == null || business.deletedBy.trim() === "") {
        payload.deletedBy = actorDocument;
      }
      if (Object.keys(payload).length > 0) {
        await FirestoreService.update(COLLECTION_NAME, id, payload);
      }

      const deletionContext = await this.loadBusinessDeletionContext(id);
      await this.deleteAppointmentStatusTasks(deletionContext.appointmentIds);
      await this.deleteDocuments(REVIEWS_COLLECTION, deletionContext.reviewIds);
      await this.deleteDocuments(METRICS_COLLECTION, deletionContext.metricIds);
      await this.deleteUserBusinessMembershipLinks(
        deletionContext.users,
        id,
        new Set(deletionContext.membershipIds)
      );
      await this.deleteDocuments(
        BUSINESS_MEMBERSHIPS_COLLECTION,
        deletionContext.membershipIds
      );
      await this.deleteRoleDocuments(deletionContext.roleIds);
      await this.deleteDocuments(APPOINTMENTS_COLLECTION, deletionContext.appointmentIds);
      await this.deleteDocuments(BOOKINGS_COLLECTION, deletionContext.bookingIds);
      await this.deleteDocuments(SERVICES_COLLECTION, deletionContext.serviceIds);
      await this.deleteDocuments(BRANCHES_COLLECTION, deletionContext.branchIds);
      await this.deleteBusinessStorageFolder(id);
      return this.normalizeBusiness(
        await FirestoreService.getById<Business>(COLLECTION_NAME, id)
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async toggleBusinessStatus(
    id: string,
    opts: { actorDocument: string }
  ): Promise<Business> {
    try {
      const business = await FirestoreService.getById<Business>(COLLECTION_NAME, id);

      if (business.status === "DELETED") {
        throw CustomError.badRequest("No se puede modificar el estado de un negocio eliminado");
      }

      let newStatus: "ACTIVE" | "INACTIVE";
      switch (business.status) {
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

      await FirestoreService.update(COLLECTION_NAME, id, {
        status: newStatus,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      if (newStatus === "INACTIVE") {
        await this.markMembershipsAsInactiveByBusiness(id);
      } else {
        await this.ensureCreatorMembership(id, opts.actorDocument);
      }

      return this.normalizeBusiness(
        await FirestoreService.getById<Business>(COLLECTION_NAME, id)
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async ensureCreatorMembership(
    businessId: string,
    creatorDocument: string
  ): Promise<void> {
    if (!this.userService) {
      throw CustomError.internalServerError(
        "No se pudo resolver el usuario creador del negocio"
      );
    }

    const creatorUser = await this.userService.getByDocument(creatorDocument.trim());
    if (!creatorUser) {
      throw CustomError.notFound(
        "No existe un usuario con el document del token para asignar membresía"
      );
    }

    const memberships = await FirestoreService.getAll<BusinessMembership>(
      BUSINESS_MEMBERSHIPS_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );
    const existingMembership = memberships.find(
      (membership) =>
        membership.userId === creatorUser.document || membership.userId === creatorUser.id
    );

    const now = FirestoreDataBase.generateTimeStamp();
    let membershipId: string;

    if (existingMembership) {
      membershipId = existingMembership.id;
      await FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membershipId, {
        userId: creatorUser.document,
        roleId: ROOT_SUPER_ADMIN_ID,
        status: "ACTIVE" as const,
        deletedAt: null,
        updatedAt: now,
      });
    } else {
      const createdMembership = await FirestoreService.create(
        BUSINESS_MEMBERSHIPS_COLLECTION,
        {
          businessId,
          userId: creatorUser.document,
          isEmployee: false,
          roleId: ROOT_SUPER_ADMIN_ID,
          status: "ACTIVE" as const,
          createdAt: now,
        }
      );
      membershipId = createdMembership.id;
    }

    await FirestoreService.createInSubcollection(
      USERS_COLLECTION,
      creatorUser.id,
      "businessMemberships",
      {
        id: membershipId,
        businessId,
      }
    );
  }

  private async markMembershipsAsInactiveByBusiness(
    businessId: string
  ): Promise<void> {
    const memberships = await FirestoreService.getAll<BusinessMembership>(
      BUSINESS_MEMBERSHIPS_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const updates = memberships.map((membership) => {
      if (membership.status === "DELETED" || membership.status === "INACTIVE") {
        return Promise.resolve();
      }
      return FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membership.id, {
        status: "INACTIVE" as const,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });
    });

    await Promise.all(updates);
  }

  private async deleteBusinessStorageFolder(businessId: string): Promise<void> {
    const storagePrefix = `bussinesses/${businessId}/`;
    const bucket = FirestoreDataBase.getAdmin().storage().bucket();
    await bucket.deleteFiles({ prefix: storagePrefix });
  }

  private async loadBusinessDeletionContext(
    businessId: string
  ): Promise<BusinessDeletionContext> {
    const [
      memberships,
      roles,
      services,
      branches,
      bookings,
      appointmentsByBusiness,
      reviews,
      businessMetrics,
    ] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(BUSINESS_MEMBERSHIPS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<FirestoreEntityWithId>(ROLES_COLLECTION, [
        { field: "type", operator: "==", value: "CUSTOM" },
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<FirestoreEntityWithId>(SERVICES_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<FirestoreEntityWithId>(BRANCHES_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<FirestoreEntityWithId>(BOOKINGS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<AppointmentDeletionRecord>(APPOINTMENTS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<FirestoreEntityWithId>(REVIEWS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<FirestoreEntityWithId>(METRICS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
    ]);

    const appointmentsByBookingList = await Promise.all(
      bookings.map((booking) =>
        FirestoreService.getAll<AppointmentDeletionRecord>(APPOINTMENTS_COLLECTION, [
          { field: "bookingId", operator: "==", value: booking.id },
        ])
      )
    );

    const appointmentsById = new Map<string, AppointmentDeletionRecord>();
    appointmentsByBusiness.forEach((appointment) => appointmentsById.set(appointment.id, appointment));
    appointmentsByBookingList
      .flat()
      .forEach((appointment) => appointmentsById.set(appointment.id, appointment));

    const branchIds = normalizeUniqueStrings(branches.map((branch) => branch.id));
    const appointmentRecords = Array.from(appointmentsById.values());
    const employeeUsers = await this.resolveUsersForMemberships(
      memberships.filter((membership) => membership.isEmployee === true)
    );
    const employeeMetricIdentifiers = this.buildEmployeeMetricIdentifiers(
      memberships,
      appointmentRecords,
      employeeUsers
    );

    const [branchMetricsByBranch, employeeMetricsByEmployee] = await Promise.all([
      Promise.all(
        branchIds.map((branchId) =>
          FirestoreService.getAll<FirestoreEntityWithId>(METRICS_COLLECTION, [
            { field: "type", operator: "==", value: "BRANCH" },
            { field: "branchId", operator: "==", value: branchId },
          ])
        )
      ),
      Promise.all(
        employeeMetricIdentifiers.map((employeeId) =>
          FirestoreService.getAll<FirestoreEntityWithId>(METRICS_COLLECTION, [
            { field: "type", operator: "==", value: "EMPLOYEE" },
            { field: "employeeId", operator: "==", value: employeeId },
          ])
        )
      ),
    ]);

    return {
      appointmentIds: normalizeUniqueStrings(appointmentRecords.map((appointment) => appointment.id)),
      bookingIds: normalizeUniqueStrings(bookings.map((booking) => booking.id)),
      branchIds,
      membershipIds: normalizeUniqueStrings(memberships.map((membership) => membership.id)),
      metricIds: normalizeUniqueStrings([
        ...businessMetrics.map((metric) => metric.id),
        ...branchMetricsByBranch.flat().map((metric) => metric.id),
        ...employeeMetricsByEmployee.flat().map((metric) => metric.id),
      ]),
      reviewIds: normalizeUniqueStrings(reviews.map((review) => review.id)),
      roleIds: normalizeUniqueStrings(roles.map((role) => role.id)),
      serviceIds: normalizeUniqueStrings(services.map((service) => service.id)),
      users: await this.resolveUsersForMemberships(memberships),
    };
  }

  private async resolveUsersForMemberships(
    memberships: BusinessMembership[]
  ): Promise<User[]> {
    const membershipUserIds = normalizeUniqueStrings(
      memberships.map((membership) => membership.userId)
    );
    if (membershipUserIds.length === 0) {
      return [];
    }

    const [usersById, usersByDocument] = await Promise.all([
      this.getUsersByField("id", membershipUserIds),
      this.getUsersByField("document", membershipUserIds),
    ]);

    const usersByResolvedId = new Map<string, User>();
    usersById.forEach((user) => usersByResolvedId.set(user.id, user));
    usersByDocument.forEach((user) => usersByResolvedId.set(user.id, user));

    return Array.from(usersByResolvedId.values());
  }

  private async getUsersByField(
    field: "id" | "document",
    values: string[]
  ): Promise<User[]> {
    if (values.length === 0) {
      return [];
    }

    const chunkSize = 30;
    const chunks: string[][] = [];
    for (let index = 0; index < values.length; index += chunkSize) {
      chunks.push(values.slice(index, index + chunkSize));
    }

    const results = await Promise.all(
      chunks.map((chunk) =>
        FirestoreService.getAll<User>(USERS_COLLECTION, [
          { field, operator: "in", value: chunk },
        ])
      )
    );

    return results.flat();
  }

  private buildEmployeeMetricIdentifiers(
    memberships: BusinessMembership[],
    appointments: AppointmentDeletionRecord[],
    users: User[]
  ): string[] {
    const membershipEmployeeIds = memberships
      .filter((membership) => membership.isEmployee === true)
      .map((membership) => membership.userId);
    const appointmentEmployeeIds = appointments.map((appointment) => appointment.employeeId);
    const resolvedUserIds = users.flatMap((user) => [user.id, user.document]);

    return normalizeUniqueStrings([
      ...membershipEmployeeIds,
      ...appointmentEmployeeIds,
      ...resolvedUserIds,
    ]);
  }

  private async deleteAppointmentStatusTasks(appointmentIds: string[]): Promise<void> {
    if (this.appointmentStatusTaskScheduler == null) {
      return;
    }

    await Promise.all(
      normalizeUniqueStrings(appointmentIds).map(async (appointmentId) => {
        try {
          await this.appointmentStatusTaskScheduler!.deleteAppointmentStatusTasks({
            appointmentId,
          });
        } catch (taskError) {
          const detail =
            taskError instanceof Error
              ? taskError.message
              : typeof taskError === "string"
                ? taskError
                : JSON.stringify(taskError);

          logger.warn(
            `[BusinessService] No se pudieron eliminar tasks automáticas para appointment ${appointmentId} durante la eliminación del negocio. detalle=${detail}`
          );
        }
      })
    );
  }

  private async deleteUserBusinessMembershipLinks(
    users: User[],
    businessId: string,
    membershipIds: Set<string>
  ): Promise<void> {
    const normalizedBusinessId = businessId.trim();
    if (normalizedBusinessId === "") {
      return;
    }

    await Promise.all(
      users.map(async (user) => {
        const links = await FirestoreService.getAllFromSubcollection<FirestoreMembershipLinkDoc>(
          USERS_COLLECTION,
          user.id,
          USER_BUSINESS_MEMBERSHIPS_SUBCOLLECTION
        );

        const linkIdsToDelete = links
          .filter((link) => {
            const linkBusinessId = link.businessId?.trim() ?? "";
            const linkMembershipId = link.membershipId?.trim() ?? "";

            return (
              linkBusinessId === normalizedBusinessId ||
              membershipIds.has(linkMembershipId) ||
              membershipIds.has(link.id)
            );
          })
          .map((link) => link.id);

        await Promise.all(
          linkIdsToDelete.map((linkId) =>
            FirestoreService.deleteSubcollectionDocument(
              USERS_COLLECTION,
              user.id,
              USER_BUSINESS_MEMBERSHIPS_SUBCOLLECTION,
              linkId
            )
          )
        );
      })
    );
  }

  private async deleteRoleDocuments(roleIds: string[]): Promise<void> {
    await Promise.all(
      normalizeUniqueStrings(roleIds).map(async (roleId) => {
        await FirestoreService.deleteSubcollectionDocuments(
          ROLES_COLLECTION,
          roleId,
          ROLE_PERMISSIONS_SUBCOLLECTION
        );
        await this.deleteDocumentIfExists(ROLES_COLLECTION, roleId);
      })
    );
  }

  private async deleteDocuments(
    collectionName: string,
    ids: string[]
  ): Promise<void> {
    await Promise.all(
      normalizeUniqueStrings(ids).map((id) =>
        this.deleteDocumentIfExists(collectionName, id)
      )
    );
  }

  private async deleteDocumentIfExists(
    collectionName: string,
    id: string
  ): Promise<void> {
    try {
      await FirestoreService.delete(collectionName, id);
    } catch (error) {
      if (
        error instanceof CustomError &&
        error.statusCode === 404
      ) {
        return;
      }
      throw error;
    }
  }

  private async syncServices(
    businessId: string,
    services: CreateServiceItemDto[]
  ): Promise<void> {
    const existingServices = await FirestoreService.getAll<Service>(
      SERVICES_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const existingByName = new Map<string, Service>();
    existingServices.forEach((service) => {
      const nameKey = toNameKey(service.name);
      if (!existingByName.has(nameKey)) {
        existingByName.set(nameKey, service);
      }
    });

    const namesInRequest = new Set<string>();
    for (const item of services) {
      const nameKey = toNameKey(item.name);
      if (namesInRequest.has(nameKey)) {
        throw CustomError.conflict("Nombre de servicio duplicado en la solicitud");
      }
      namesInRequest.add(nameKey);

      const existing = existingByName.get(nameKey);
      if (existing) {
        await FirestoreService.update(SERVICES_COLLECTION, existing.id, {
          duration: item.duration,
          price: item.price,
          description: item.description ?? "",
          ...(item.imageUrl !== undefined && { imageUrl: item.imageUrl }),
          status: "ACTIVE",
          deletedAt: null,
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        });
        continue;
      }

      await FirestoreService.create(SERVICES_COLLECTION, {
        businessId,
        name: item.name,
        duration: item.duration,
        price: item.price,
        description: item.description ?? "",
        ...(item.imageUrl !== undefined && { imageUrl: item.imageUrl }),
        status: "ACTIVE" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });
    }

    const toDelete = existingServices.filter(
      (service) =>
        service.status !== "DELETED" && !namesInRequest.has(toNameKey(service.name))
    );
    if (toDelete.length > 0) {
      if (this.serviceService) {
        await Promise.all(
          toDelete.map((service) => this.serviceService!.deleteService(service.id))
        );
      } else {
        await Promise.all(
          toDelete.map((service) =>
            FirestoreService.update(SERVICES_COLLECTION, service.id, {
              status: "DELETED" as const,
              deletedAt: FirestoreDataBase.generateTimeStamp(),
              updatedAt: FirestoreDataBase.generateTimeStamp(),
            })
          )
        );
      }
    }
  }

  private async syncBranches(
    businessId: string,
    branches: CreateBranchItemDto[]
  ): Promise<void> {
    const existingBranches = await FirestoreService.getAll<Branch>(
      BRANCHES_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const existingByName = new Map<string, Branch>();
    existingBranches.forEach((branch) => {
      const nameKey = toNameKey(branch.name);
      if (!existingByName.has(nameKey)) {
        existingByName.set(nameKey, branch);
      }
    });

    const namesInRequest = new Set<string>();
    for (const item of branches) {
      const nameKey = toNameKey(item.name);
      if (namesInRequest.has(nameKey)) {
        throw CustomError.conflict("Nombre de sede duplicado en la solicitud");
      }
      namesInRequest.add(nameKey);

      const existing = existingByName.get(nameKey);
      if (existing) {
        await FirestoreService.update(BRANCHES_COLLECTION, existing.id, {
          address: item.address,
          location: item.location,
          phone: item.phone,
          phoneHasWhatsapp: item.phoneHasWhatsapp,
          schedule: item.schedule,
          imageGallery: item.imageGallery,
          status: "ACTIVE",
          deletedAt: null,
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        });
        continue;
      }

      await FirestoreService.create(BRANCHES_COLLECTION, {
        businessId,
        name: item.name,
        address: item.address,
        location: item.location,
        phone: item.phone,
        phoneHasWhatsapp: item.phoneHasWhatsapp,
        schedule: item.schedule,
        imageGallery: item.imageGallery,
        status: "ACTIVE" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });
    }

    const toDelete = existingBranches.filter(
      (branch) =>
        branch.status !== "DELETED" && !namesInRequest.has(toNameKey(branch.name))
    );
    if (toDelete.length > 0) {
      if (this.branchService) {
        await Promise.all(
          toDelete.map((branch) => this.branchService!.deleteBranch(branch.id))
        );
      } else {
        await Promise.all(
          toDelete.map((branch) =>
            FirestoreService.update(BRANCHES_COLLECTION, branch.id, {
              status: "DELETED" as const,
              deletedAt: FirestoreDataBase.generateTimeStamp(),
              updatedAt: FirestoreDataBase.generateTimeStamp(),
            })
          )
        );
      }
    }
  }

  private normalizeBusiness(business: Business): Business {
    return {
      ...business,
      consecutivePrefix: normalizeConsecutivePrefix(business.consecutivePrefix),
    };
  }
}
