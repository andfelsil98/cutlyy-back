import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { randomInt } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
  DEFAULT_CROSS_BUSINESS_ADMIN_ROLE_NAME,
  type AccessEntityType,
} from "../../domain/constants/access-control.constants";
import { CustomError } from "../../domain/errors/custom-error";
import type {
  Business,
  BusinessDeletionState,
  BusinessDeletionStatusResponse,
  BusinessDeletionSummary,
  CreateBusinessCompleteResult,
} from "../../domain/interfaces/business.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import type { Permission } from "../../domain/interfaces/permission.interface";
import type { Role } from "../../domain/interfaces/role.interface";
import type { Service } from "../../domain/interfaces/service.interface";
import type { User } from "../../domain/interfaces/user.interface";
import type { Usage } from "../../domain/interfaces/usage.interface";
import type { OutboxEventPayload } from "../../domain/interfaces/outbox-event.interface";
import type { PaginatedResult, PaginationParams } from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import { normalizeConsecutivePrefix } from "../../domain/utils/booking-consecutive.utils";
import { slugFromName } from "../../domain/utils/string.utils";
import { logger } from "../../infrastructure/logger/logger";
import type { CreateBusinessDto } from "../business/dtos/create-business.dto";
import type { CreateBusinessCompleteDto } from "../business/dtos/create-business-complete.dto";
import type { UpdateBusinessDto } from "../business/dtos/update-business.dto";
import type { CreateBranchItemDto } from "../branch/dtos/create-branch.dto";
import type { CreateServiceItemDto } from "../service/dtos/create-service.dto";
import type { AppointmentStatusTaskScheduler } from "./appointment-status-task-scheduler.service";
import { BusinessUsageLimitService } from "./business-usage-limit.service";
import { BusinessUsageService } from "./business-usage.service";
import type { BranchService } from "./branch.service";
import { FirestoreConsistencyService } from "./firestore-consistency.service";
import FirestoreService from "./firestore.service";
import { OutboxService } from "./outbox.service";
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
const BUSINESS_SLUGS_COLLECTION = "BusinessSlugs";
const USER_BUSINESS_MEMBERSHIPS_SUBCOLLECTION = "businessMemberships";
const ROLE_PERMISSIONS_SUBCOLLECTION = "Permissions";
const USAGE_SUBCOLLECTION = "usage";
const PERMISSIONS_COLLECTION = "Permissions";
const BUSINESS_SLUG_SUFFIX_LENGTH = 4;
const MAX_BUSINESS_SLUG_ATTEMPTS = 25;
const FIRESTORE_DELETE_BATCH_SIZE = 450;
const BUSINESS_STATUSES_THAT_BLOCK_CONSECUTIVE_PREFIX = [
  "ACTIVE",
  "INACTIVE",
  "PENDING",
] as const;
const BUSINESS_DELETION_STAGES = [
  "mark-business-as-deleted",
  "load-deletion-context",
  "delete-appointment-status-tasks",
  "delete-business-usage",
  "delete-reviews",
  "delete-metrics",
  "delete-user-business-membership-links",
  "delete-business-memberships",
  "delete-roles",
  "delete-appointments",
  "delete-bookings",
  "delete-services",
  "delete-branches",
  "delete-storage-folder",
] as const;
const BUSINESS_DELETION_TERMINAL_STAGE = "COMPLETED" as const;

type BusinessDeletionStage =
  | (typeof BUSINESS_DELETION_STAGES)[number]
  | typeof BUSINESS_DELETION_TERMINAL_STAGE;
type BusinessDeletionStatus = "RUNNING" | "FAILED" | "COMPLETED";

interface BusinessDeletionOutboxPayload extends OutboxEventPayload {
  businessId: string;
  actorDocument: string;
}

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

class BusinessSlugAlreadyReservedError extends Error {}

function normalizeUniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim() ?? "")
        .filter((value) => value !== "")
    )
  );
}

function shouldSkipStorageCleanup(error: unknown): boolean {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  const normalizedDetail = detail.toLowerCase();
  return normalizedDetail.includes("bucket name not specified or invalid");
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

type BusinessRecord = Omit<Business, "subscriptionStatus"> & {
  subscriptionStatus?: Business["subscriptionStatus"];
  planId?: Business["planId"];
  deletion?: BusinessDeletionState;
};

export class BusinessService {
  constructor(
    private readonly serviceService?: ServiceService,
    private readonly branchService?: BranchService,
    private readonly userService?: UserService,
    private readonly appointmentStatusTaskScheduler?: AppointmentStatusTaskScheduler,
    private readonly businessUsageService: BusinessUsageService = new BusinessUsageService(),
    private readonly businessUsageLimitService: BusinessUsageLimitService =
      new BusinessUsageLimitService(),
    private readonly firestoreConsistencyService: FirestoreConsistencyService =
      new FirestoreConsistencyService(),
    private readonly outboxService: OutboxService = new OutboxService()
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
      const normalizedBusinesses = result.data.map((business) =>
        this.normalizeBusiness(business)
      );

      if (params.id == null || params.id.trim() === "") {
        return {
          ...result,
          data: normalizedBusinesses,
        };
      }

      const businessesWithUsage = await Promise.all(
        normalizedBusinesses.map(async (business) => ({
          ...business,
          usage: (await this.businessUsageService.getUsages(business.id)).map((usage) =>
            this.mapUsageToResponse(usage)
          ),
        }))
      );

      return {
        ...result,
        data: businessesWithUsage,
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async getBusinessDeletionStatus(
    id: string
  ): Promise<BusinessDeletionStatusResponse> {
    try {
      const business = await FirestoreService.getById<BusinessRecord>(COLLECTION_NAME, id);
      return {
        businessId: business.id,
        businessStatus: business.status,
        deletion: business.deletion ?? null,
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      logger.error(
        `[BusinessService] No se pudo obtener el estado de eliminación del negocio ${id}. detalle=${detail}`
      );
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createBusiness(dto: CreateBusinessDto): Promise<Business> {
    let createdBusinessId: string | null = null;
    let createdBusinessSlug: string | null = null;

    try {
      await this.businessUsageService.ensurePlanExists(dto.planId);

      const businessWithSameConsecutivePrefix = await FirestoreService.getAll<Business>(
        COLLECTION_NAME,
        [
          {
            field: "status",
            operator: "in",
            value: [...BUSINESS_STATUSES_THAT_BLOCK_CONSECUTIVE_PREFIX],
          },
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
      const createdBusiness = await this.createBusinessWithReservedSlug(dto);
      createdBusinessId = createdBusiness.id;
      createdBusinessSlug = createdBusiness.slug;

      await this.businessUsageService.rebuildBusinessUsage({
        businessId: createdBusiness.id,
        planId: dto.planId,
        startPeriods: dto.startPeriods,
      });

      return this.normalizeBusiness(
        await FirestoreService.getById<BusinessRecord>(COLLECTION_NAME, createdBusiness.id)
      );
    } catch (error) {
      if (createdBusinessId != null) {
        await this.businessUsageService.deleteBusinessUsage(createdBusinessId).catch(() => undefined);
        await FirestoreService.delete(COLLECTION_NAME, createdBusinessId).catch(() => undefined);
      }
      if (createdBusinessSlug != null) {
        await this.releaseBusinessSlug(createdBusinessSlug).catch(() => undefined);
      }
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
        planId: dto.planId,
        startPeriods: dto.startPeriods,
        consecutivePrefix: dto.consecutivePrefix,
        ...(dto.logoUrl !== undefined && dto.logoUrl !== "" && { logoUrl: dto.logoUrl }),
      });

      await this.ensureCreatorMembership(business.id, opts.creatorDocument);

      return { business, services: [], branches: [] };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updateBusiness(id: string, dto: UpdateBusinessDto): Promise<Business> {
    try {
      const currentBusiness = await FirestoreService.getById<BusinessRecord>(COLLECTION_NAME, id);

      if (dto.planId !== undefined) {
        await this.businessUsageService.ensurePlanExists(dto.planId);
      }

      if (dto.consecutivePrefix !== undefined) {
        const businessesWithSameConsecutivePrefix = await FirestoreService.getAll<Business>(
          COLLECTION_NAME,
          [
            {
              field: "status",
              operator: "in",
              value: [...BUSINESS_STATUSES_THAT_BLOCK_CONSECUTIVE_PREFIX],
            },
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
      if (dto.type !== undefined) payload.type = dto.type;
      if (dto.consecutivePrefix !== undefined) {
        payload.consecutivePrefix = dto.consecutivePrefix;
      }
      if (dto.logoUrl !== undefined) payload.logoUrl = dto.logoUrl;

      await FirestoreService.update(COLLECTION_NAME, id, payload);

      if (dto.planId !== undefined || dto.startPeriods !== undefined) {
        await this.businessUsageService.rebuildBusinessUsage({
          businessId: id,
          planId: dto.planId ?? this.resolveCurrentPlanId(currentBusiness),
          startPeriods:
            dto.startPeriods ?? (await this.getExistingStartPeriods(id)),
        });
      }

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
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      logger.error(`[BusinessService] No se pudo actualizar el negocio ${id}. detalle=${detail}`);
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteBusiness(
    id: string,
    opts: { actorDocument: string }
  ): Promise<Business> {
    try {
      const business = await FirestoreService.getById<BusinessRecord>(COLLECTION_NAME, id);
      const actorDocument = opts.actorDocument.trim();
      if (actorDocument === "") {
        throw CustomError.badRequest(
          "No se pudo resolver el documento del actor que elimina el negocio"
        );
      }

      if (business.deletion?.status === "COMPLETED") {
        return this.normalizeBusiness(business);
      }

      await this.markBusinessAsDeletedForCascade(business, actorDocument);

      const existingEventId = business.deletion?.eventId?.trim() ?? "";
      let nextEventId = existingEventId;
      if (business.deletion?.status === "FAILED" && existingEventId !== "") {
        await this.outboxService.requeue(existingEventId).catch((error) => {
          if (error instanceof CustomError && error.statusCode === 404) {
            nextEventId = "";
            return;
          }
          throw error;
        });
      }

      if (nextEventId === "") {
        const deletionEvent = await this.outboxService.enqueue<BusinessDeletionOutboxPayload>({
          type: "BUSINESS_DELETE_CASCADE",
          aggregateType: "BUSINESS",
          aggregateId: id,
          payload: {
            businessId: id,
            actorDocument,
          },
        });
        nextEventId = deletionEvent.id;
      }

      await this.persistBusinessDeletionProgress(id, {
        status: "RUNNING",
        stage:
          business.deletion?.stage != null &&
          business.deletion.stage !== BUSINESS_DELETION_TERMINAL_STAGE
            ? business.deletion.stage
            : "mark-business-as-deleted",
        summary: business.deletion?.summary ?? null,
        clearLastError: true,
        completed: false,
        eventId: nextEventId,
      });

      return this.normalizeBusiness(
        await FirestoreService.getById<BusinessRecord>(COLLECTION_NAME, id)
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      logger.error(
        `[BusinessService] No se pudo encolar la eliminación del negocio ${id}. detalle=${detail}`
      );
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async replayBusinessDeletionCascadeEvent(
    input: BusinessDeletionOutboxPayload
  ): Promise<void> {
    await this.processBusinessDeletionCascade(input.businessId, input.actorDocument);
  }

  private async processBusinessDeletionCascade(
    id: string,
    requestedActorDocument: string
  ): Promise<void> {
    let deletionStage: BusinessDeletionStage | "load-business" = "load-business";
    let deletionContextSummary: BusinessDeletionSummary | null = null;
    let canPersistDeletionProgress = false;

    try {
      const business = await FirestoreService.getById<BusinessRecord>(COLLECTION_NAME, id);
      canPersistDeletionProgress = true;
      deletionContextSummary = business.deletion?.summary ?? null;

      const actorDocument = this.resolveBusinessDeletionActorDocument(
        business,
        requestedActorDocument
      );
      if (actorDocument === "") {
        throw CustomError.badRequest(
          "No se pudo resolver el documento del actor que elimina el negocio"
        );
      }

      if (business.deletion?.status === "COMPLETED") {
        return;
      }

      const deletionStartIndex = this.resolveBusinessDeletionStartIndex(business);
      deletionStage = "load-deletion-context";
      for (const stage of BUSINESS_DELETION_STAGES.slice(deletionStartIndex)) {
        deletionStage = stage;
        await this.persistBusinessDeletionProgress(id, {
          status: "RUNNING",
          stage,
          summary: deletionContextSummary,
          clearLastError: true,
        });

        switch (stage) {
          case "mark-business-as-deleted":
            await this.markBusinessAsDeletedForCascade(business, actorDocument);
            break;

          case "load-deletion-context": {
            const deletionContext = await this.loadBusinessDeletionContext(id);
            deletionContextSummary = this.buildBusinessDeletionSummary(deletionContext);
            await this.persistBusinessDeletionProgress(id, {
              status: "RUNNING",
              stage,
              summary: deletionContextSummary,
              clearLastError: true,
            });
            logger.info(
              `[BusinessService] Iniciando eliminación en cascada del negocio ${id}. actor=${actorDocument}. resumen=${JSON.stringify(
                deletionContextSummary
              )}`
            );
            break;
          }

          default: {
            const deletionContext = await this.loadBusinessDeletionContext(id);
            deletionContextSummary = this.buildBusinessDeletionSummary(deletionContext);
            await this.persistBusinessDeletionProgress(id, {
              status: "RUNNING",
              stage,
              summary: deletionContextSummary,
              clearLastError: true,
            });

            await this.runBusinessDeletionStage(stage, id, deletionContext);
            break;
          }
        }
      }

      deletionStage = BUSINESS_DELETION_TERMINAL_STAGE;
      await this.persistBusinessDeletionProgress(id, {
        status: "COMPLETED",
        stage: BUSINESS_DELETION_TERMINAL_STAGE,
        summary: deletionContextSummary,
        clearLastError: true,
        completed: true,
      });

      return;
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      if (canPersistDeletionProgress && deletionStage !== "load-business") {
        await this.persistBusinessDeletionProgress(id, {
          status: "FAILED",
          stage: deletionStage,
          summary: deletionContextSummary,
          lastError: detail,
          completed: false,
        }).catch((persistError) => {
          const persistDetail =
            persistError instanceof Error
              ? persistError.stack ?? persistError.message
              : String(persistError);
          logger.error(
            `[BusinessService] No se pudo persistir el fallo de eliminación del negocio ${id}. detalle=${persistDetail}`
          );
        });
      }

      if (error instanceof CustomError) {
        logger.error(
          `[BusinessService] Falló la eliminación del negocio ${id}. stage=${deletionStage}. context=${JSON.stringify(
            deletionContextSummary
          )}. detalle=${detail}`
        );
        throw error;
      }

      logger.error(
        `[BusinessService] Falló la eliminación del negocio ${id}. stage=${deletionStage}. context=${JSON.stringify(
          deletionContextSummary
        )}. detalle=${detail}`
      );
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async markBusinessAsDeletedForCascade(
    business: BusinessRecord,
    actorDocument: string
  ): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (business.status !== "DELETED") {
      payload.status = "DELETED" as const;
      payload.updatedAt = FirestoreDataBase.generateTimeStamp();
    }
    if (business.deletedAt == null) {
      payload.deletedAt = FirestoreDataBase.generateTimeStamp();
    }
    if (business.deletedBy == null || business.deletedBy.trim() === "") {
      payload.deletedBy = actorDocument;
    }

    if (Object.keys(payload).length === 0) {
      return;
    }

    await FirestoreService.update(COLLECTION_NAME, business.id, payload);
  }

  private buildBusinessDeletionSummary(
    deletionContext: BusinessDeletionContext
  ): BusinessDeletionSummary {
    return {
      appointments: deletionContext.appointmentIds.length,
      bookings: deletionContext.bookingIds.length,
      branches: deletionContext.branchIds.length,
      memberships: deletionContext.membershipIds.length,
      metrics: deletionContext.metricIds.length,
      reviews: deletionContext.reviewIds.length,
      roles: deletionContext.roleIds.length,
      services: deletionContext.serviceIds.length,
      users: deletionContext.users.length,
    };
  }

  private resolveBusinessDeletionActorDocument(
    business: BusinessRecord,
    requestedActorDocument: string
  ): string {
    const normalizedRequestedActorDocument = requestedActorDocument.trim();
    if (normalizedRequestedActorDocument !== "") {
      return normalizedRequestedActorDocument;
    }

    return business.deletedBy?.trim() ?? "";
  }

  private resolveBusinessDeletionStartIndex(business: BusinessRecord): number {
    const deletionState = business.deletion;
    if (deletionState == null) {
      return 0;
    }

    if (deletionState.status === "COMPLETED") {
      return BUSINESS_DELETION_STAGES.length;
    }

    const stageIndex = BUSINESS_DELETION_STAGES.indexOf(
      deletionState.stage as (typeof BUSINESS_DELETION_STAGES)[number]
    );
    if (stageIndex < 0) {
      return 0;
    }

    return stageIndex;
  }

  private async persistBusinessDeletionProgress(
    businessId: string,
    input: {
      status: BusinessDeletionStatus;
      stage: BusinessDeletionStage;
      summary?: BusinessDeletionSummary | null;
      lastError?: string;
      clearLastError?: boolean;
      completed?: boolean;
      eventId?: string;
    }
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      "deletion.status": input.status,
      "deletion.stage": input.stage,
      "deletion.updatedAt": new Date().toISOString(),
    };

    if (input.summary != null) {
      payload["deletion.summary"] = input.summary;
    }

    const normalizedEventId = input.eventId?.trim() ?? "";
    if (normalizedEventId !== "") {
      payload["deletion.eventId"] = normalizedEventId;
    }

    const normalizedLastError = input.lastError?.trim() ?? "";
    if (normalizedLastError !== "") {
      payload["deletion.lastError"] = normalizedLastError;
    } else if (input.clearLastError === true) {
      payload["deletion.lastError"] = FieldValue.delete();
    }

    if (input.completed === true) {
      payload["deletion.completedAt"] = new Date().toISOString();
    } else if (input.completed === false) {
      payload["deletion.completedAt"] = FieldValue.delete();
    }

    await FirestoreService.update(COLLECTION_NAME, businessId, payload);
  }

  private async runBusinessDeletionStage(
    stage: (typeof BUSINESS_DELETION_STAGES)[number],
    businessId: string,
    deletionContext: BusinessDeletionContext
  ): Promise<void> {
    switch (stage) {
      case "mark-business-as-deleted":
      case "load-deletion-context":
        return;

      case "delete-appointment-status-tasks":
        await this.deleteAppointmentStatusTasks(deletionContext.appointmentIds);
        return;

      case "delete-business-usage":
        await this.businessUsageService.deleteBusinessUsage(businessId);
        return;

      case "delete-reviews":
        await this.deleteDocuments(REVIEWS_COLLECTION, deletionContext.reviewIds);
        return;

      case "delete-metrics":
        await this.deleteDocuments(METRICS_COLLECTION, deletionContext.metricIds);
        return;

      case "delete-user-business-membership-links":
        await this.deleteUserBusinessMembershipLinks(
          deletionContext.users,
          businessId,
          new Set(deletionContext.membershipIds)
        );
        return;

      case "delete-business-memberships":
        await this.deleteDocuments(
          BUSINESS_MEMBERSHIPS_COLLECTION,
          deletionContext.membershipIds
        );
        return;

      case "delete-roles":
        await this.deleteRoleDocuments(deletionContext.roleIds);
        return;

      case "delete-appointments":
        await this.deleteDocuments(
          APPOINTMENTS_COLLECTION,
          deletionContext.appointmentIds
        );
        return;

      case "delete-bookings":
        await this.deleteDocuments(BOOKINGS_COLLECTION, deletionContext.bookingIds);
        return;

      case "delete-services":
        await this.deleteDocuments(SERVICES_COLLECTION, deletionContext.serviceIds);
        return;

      case "delete-branches":
        await this.deleteDocuments(BRANCHES_COLLECTION, deletionContext.branchIds);
        return;

      case "delete-storage-folder":
        await this.deleteBusinessStorageFolder(businessId);
        return;
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

  private async createBusinessWithReservedSlug(
    dto: CreateBusinessDto
  ): Promise<{ id: string; slug: string }> {
    const db = FirestoreDataBase.getDB();
    const baseSlug = slugFromName(dto.name);
    if (baseSlug === "") {
      throw CustomError.badRequest(
        "No fue posible generar un identificador válido para el negocio"
      );
    }

    const businessRef = db.collection(COLLECTION_NAME).doc();

    for (let attempt = 0; attempt < MAX_BUSINESS_SLUG_ATTEMPTS; attempt += 1) {
      const candidateSlug =
        attempt === 0
          ? baseSlug
          : `${baseSlug}-${this.generateBusinessSlugSuffix(BUSINESS_SLUG_SUFFIX_LENGTH)}`;
      const slugReservationRef = db
        .collection(BUSINESS_SLUGS_COLLECTION)
        .doc(candidateSlug);

      try {
        await db.runTransaction(async (transaction) => {
          const reservationSnapshot = await transaction.get(slugReservationRef);
          if (reservationSnapshot.exists) {
            throw new BusinessSlugAlreadyReservedError(candidateSlug);
          }

          const createdAt = FirestoreDataBase.generateTimeStamp();
          transaction.set(businessRef, {
            id: businessRef.id,
            name: dto.name,
            type: dto.type,
            planId: dto.planId,
            subscriptionStatus: "INACTIVE" as const,
            slug: candidateSlug,
            consecutivePrefix: dto.consecutivePrefix,
            employees: [] as string[],
            logoUrl: dto.logoUrl ?? "",
            status: "ACTIVE" as const,
            createdAt,
          });
          transaction.set(slugReservationRef, {
            id: candidateSlug,
            slug: candidateSlug,
            baseSlug,
            businessId: businessRef.id,
            createdAt,
          });
        });

        return {
          id: businessRef.id,
          slug: candidateSlug,
        };
      } catch (error) {
        if (error instanceof BusinessSlugAlreadyReservedError) {
          continue;
        }
        throw error;
      }
    }

    throw CustomError.conflict(
      "No fue posible generar un identificador único para el negocio"
    );
  }

  private generateBusinessSlugSuffix(length: number): string {
    const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
    let suffix = "";

    for (let index = 0; index < length; index += 1) {
      suffix += characters[randomInt(0, characters.length)];
    }

    return suffix;
  }

  private async releaseBusinessSlug(slug: string): Promise<void> {
    await FirestoreDataBase.getDB()
      .collection(BUSINESS_SLUGS_COLLECTION)
      .doc(slug)
      .delete();
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

    const defaultCrossBusinessRoleId =
      await this.resolveDefaultCrossBusinessAdminRoleId();
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
        roleId: defaultCrossBusinessRoleId,
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
          roleId: defaultCrossBusinessRoleId,
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
        membershipId,
        businessId,
      }
    );
  }

  private async resolveDefaultCrossBusinessAdminRoleId(): Promise<string> {
    const existingRoles = await FirestoreService.getAll<Role>(ROLES_COLLECTION, [
      { field: "type", operator: "==", value: "CROSS_BUSINESS" },
    ]);

    const existingRole =
      existingRoles.find(
        (role) =>
          toNameKey(role.name) === toNameKey(DEFAULT_CROSS_BUSINESS_ADMIN_ROLE_NAME)
      ) ?? existingRoles[0] ?? null;
    if (existingRole) {
      return existingRole.id;
    }

    const permissions = await FirestoreService.getAll<Permission>(
      PERMISSIONS_COLLECTION
    );
    const compatiblePermissions = permissions.filter(
      (permission) =>
        permission.type === "BUSINESS" || permission.type === "HYBRID"
    );

    const createdRole = await FirestoreService.create(ROLES_COLLECTION, {
      name: DEFAULT_CROSS_BUSINESS_ADMIN_ROLE_NAME,
      type: "CROSS_BUSINESS" as const,
      permissionsCount: compatiblePermissions.length,
      createdAt: FirestoreDataBase.generateTimeStamp(),
    });

    await Promise.all(
      compatiblePermissions.map((permission) =>
        FirestoreService.createInSubcollection(
          ROLES_COLLECTION,
          createdRole.id,
          ROLE_PERMISSIONS_SUBCOLLECTION,
          {
            id: permission.id,
            name: permission.name,
            value: permission.value,
            moduleId: permission.moduleId,
            type: permission.type as AccessEntityType,
          }
        )
      )
    );

    return createdRole.id;
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
    try {
      const bucket = FirestoreDataBase.getAdmin().storage().bucket();
      await bucket.deleteFiles({ prefix: storagePrefix });
    } catch (error) {
      if (shouldSkipStorageCleanup(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[BusinessService] Se omite la limpieza de storage del negocio ${businessId} porque no hay bucket configurado o válido. detalle=${detail}`
        );
        return;
      }
      throw error;
    }
  }

  private async getExistingStartPeriods(businessId: string): Promise<string[]> {
    const usages = await this.businessUsageService.getUsages(businessId);
    if (usages.length === 0) {
      throw CustomError.badRequest(
        "No se encontraron períodos de usage actuales para recalcular el negocio"
      );
    }

    return usages
      .map((usage) => usage.startPeriod)
      .sort((a, b) => a.localeCompare(b));
  }

  private resolveCurrentPlanId(business: BusinessRecord): string {
    const planId = business.planId?.trim() ?? "";
    if (planId === "") {
      throw CustomError.badRequest(
        "El negocio actual no tiene un plan asociado para recalcular usage"
      );
    }

    return planId;
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
        { field: "type", operator: "==", value: "BUSINESS" },
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

    const documentsToDelete: Array<{ userId: string; linkId: string }> = [];

    await Promise.all(
      users.map(async (user) => {
        const links = await FirestoreService.getAllFromSubcollection<FirestoreMembershipLinkDoc>(
          USERS_COLLECTION,
          user.id,
          USER_BUSINESS_MEMBERSHIPS_SUBCOLLECTION
        );

        links.forEach((link) => {
          const linkBusinessId = link.businessId?.trim() ?? "";
          const linkMembershipId = link.membershipId?.trim() ?? "";

          if (
            linkBusinessId === normalizedBusinessId ||
            membershipIds.has(linkMembershipId) ||
            membershipIds.has(link.id)
          ) {
            documentsToDelete.push({
              userId: user.id,
              linkId: link.id,
            });
          }
        });
      })
    );

    for (
      let index = 0;
      index < documentsToDelete.length;
      index += FIRESTORE_DELETE_BATCH_SIZE
    ) {
      const chunk = documentsToDelete.slice(index, index + FIRESTORE_DELETE_BATCH_SIZE);
      await this.firestoreConsistencyService.runBatch(
        "BusinessService.deleteUserBusinessMembershipLinks",
        async (context) => {
          chunk.forEach((item) => {
            context.batch.delete(
              context.subdoc(
                USERS_COLLECTION,
                item.userId,
                USER_BUSINESS_MEMBERSHIPS_SUBCOLLECTION,
                item.linkId
              )
            );
          });
        }
      );
    }
  }

  private async deleteRoleDocuments(roleIds: string[]): Promise<void> {
    for (const roleId of normalizeUniqueStrings(roleIds)) {
      const permissions = await FirestoreService.getAllFromSubcollection<FirestoreEntityWithId>(
        ROLES_COLLECTION,
        roleId,
        ROLE_PERMISSIONS_SUBCOLLECTION
      );

      const permissionIds = normalizeUniqueStrings(
        permissions.map((permission) => permission.id)
      );

      for (
        let index = 0;
        index < permissionIds.length;
        index += FIRESTORE_DELETE_BATCH_SIZE
      ) {
        const chunk = permissionIds.slice(index, index + FIRESTORE_DELETE_BATCH_SIZE);
        await this.firestoreConsistencyService.runBatch(
          "BusinessService.deleteRoleDocuments.permissions",
          async (context) => {
            chunk.forEach((permissionId) => {
              context.batch.delete(
                context.subdoc(
                  ROLES_COLLECTION,
                  roleId,
                  ROLE_PERMISSIONS_SUBCOLLECTION,
                  permissionId
                )
              );
            });
          }
        );
      }

      await this.firestoreConsistencyService.runBatch(
        "BusinessService.deleteRoleDocuments.role",
        async (context) => {
          context.batch.delete(context.doc(ROLES_COLLECTION, roleId));
        }
      );
    }
  }

  private async deleteDocuments(
    collectionName: string,
    ids: string[]
  ): Promise<void> {
    const normalizedIds = normalizeUniqueStrings(ids);
    for (
      let index = 0;
      index < normalizedIds.length;
      index += FIRESTORE_DELETE_BATCH_SIZE
    ) {
      const chunk = normalizedIds.slice(index, index + FIRESTORE_DELETE_BATCH_SIZE);
      await this.firestoreConsistencyService.runBatch(
        `BusinessService.deleteDocuments.${collectionName}`,
        async (context) => {
          chunk.forEach((id) => {
            context.batch.delete(context.doc(collectionName, id));
          });
        }
      );
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
        const payload = {
          address: item.address,
          location: item.location,
          phone: item.phone,
          phoneHasWhatsapp: item.phoneHasWhatsapp,
          schedule: item.schedule,
          imageGallery: item.imageGallery,
          status: "ACTIVE" as const,
          deletedAt: null,
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        };
        if (existing.status === "DELETED") {
          await this.businessUsageLimitService.consume(businessId, "branches", 1);
          try {
            await FirestoreService.update(BRANCHES_COLLECTION, existing.id, payload);
          } catch (error) {
            await this.businessUsageLimitService.release(businessId, "branches", 1).catch(
              () => undefined
            );
            throw error;
          }
        } else {
          await FirestoreService.update(BRANCHES_COLLECTION, existing.id, payload);
        }
        continue;
      }

      await this.businessUsageLimitService.consume(businessId, "branches", 1);
      try {
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
      } catch (error) {
        await this.businessUsageLimitService.release(businessId, "branches", 1).catch(() => undefined);
        throw error;
      }
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
          toDelete.map(async (branch) => {
            await FirestoreService.update(BRANCHES_COLLECTION, branch.id, {
              status: "DELETED" as const,
              deletedAt: FirestoreDataBase.generateTimeStamp(),
              updatedAt: FirestoreDataBase.generateTimeStamp(),
            });
            await this.businessUsageLimitService.release(businessId, "branches", 1);
          })
        );
      }
    }
  }

  private normalizeBusiness(business: BusinessRecord): Business {
    return {
      ...business,
      subscriptionStatus: business.subscriptionStatus ?? "ACTIVE",
      planId: business.planId ?? "",
      consecutivePrefix: normalizeConsecutivePrefix(business.consecutivePrefix),
    };
  }

  private mapUsageToResponse(usage: Usage & { id: string }): Usage & { id: string } {
    return {
      id: usage.id,
      maxEmployees: usage.maxEmployees,
      maxBranches: usage.maxBranches,
      maxBookings: usage.maxBookings,
      maxRoles: usage.maxRoles,
      planId: usage.planId,
      startPeriod: usage.startPeriod,
      endPeriod: usage.endPeriod,
      status: usage.status,
    };
  }
}
