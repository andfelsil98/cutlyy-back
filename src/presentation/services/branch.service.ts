import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Branch, BranchScheduleDay } from "../../domain/interfaces/branch.interface";
import { slugFromName } from "../../domain/utils/string.utils";
import type { PaginatedResult, PaginationParams } from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import type { CreateBranchesBodyDto } from "../branch/dtos/create-branch.dto";
import type { UpdateBranchBodyDto } from "../branch/dtos/update-branch.dto";
import { logger } from "../../infrastructure/logger/logger";
import { BusinessUsageLimitService } from "./business-usage-limit.service";
import FirestoreService from "./firestore.service";
import { MetricService } from "./metric.service";
import { ReviewService } from "./review.service";
import { SchedulingIntegrityService } from "./scheduling-integrity.service";

const COLLECTION_NAME = "Branches";
const BUSINESS_COLLECTION = "Businesses";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeScheduleForComparison(
  schedule: BranchScheduleDay[]
): BranchScheduleDay[] {
  return [...schedule]
    .map((day) => ({
      day: day.day,
      isOpen: day.isOpen,
      slots: [...day.slots]
        .map((slot) => ({
          openingTime: slot.openingTime.trim(),
          closingTime: slot.closingTime.trim(),
        }))
        .sort((left, right) => {
          const openingComparison = left.openingTime.localeCompare(
            right.openingTime
          );
          if (openingComparison !== 0) return openingComparison;
          return left.closingTime.localeCompare(right.closingTime);
        }),
    }))
    .sort((left, right) => left.day - right.day);
}

function areSchedulesEquivalent(
  currentSchedule: BranchScheduleDay[],
  nextSchedule: BranchScheduleDay[]
): boolean {
  return (
    JSON.stringify(normalizeScheduleForComparison(currentSchedule)) ===
    JSON.stringify(normalizeScheduleForComparison(nextSchedule))
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

export class BranchService {
  constructor(
    private readonly reviewService: ReviewService = new ReviewService(),
    private readonly metricService: MetricService = new MetricService(),
    private readonly schedulingIntegrityService: SchedulingIntegrityService =
      new SchedulingIntegrityService(),
    private readonly businessUsageLimitService: BusinessUsageLimitService =
      new BusinessUsageLimitService()
  ) {}

  async getAllBranches(
    params: PaginationParams & { id?: string; businessId?: string; includeDeletes?: boolean }
  ): Promise<PaginatedResult<Branch>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const filters = [
        ...(params.id != null && params.id.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.id.trim() }]
          : []),
        ...(params.includeDeletes === true
          ? []
          : [
              {
                field: "status" as const,
                operator: "in" as const,
                value: ["ACTIVE", "INACTIVE"],
              },
            ]),
        ...(params.businessId != null && params.businessId.trim() !== ""
          ? [{ field: "businessId" as const, operator: "==" as const, value: params.businessId.trim() }]
          : []),
      ];
      return await FirestoreService.getAllPaginated<Branch>(COLLECTION_NAME, { page, pageSize }, filters);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createBranches(dto: CreateBranchesBodyDto): Promise<Branch[]> {
    try {
      const businesses = await FirestoreService.getAll<Business>(BUSINESS_COLLECTION, [
        { field: "id", operator: "==", value: dto.businessId },
      ]);
      if (businesses.length === 0) throw CustomError.notFound("No existe un negocio con este id");

      const existingBranches = await FirestoreService.getAll<Branch>(COLLECTION_NAME, [
        { field: "businessId", operator: "==", value: dto.businessId },
      ]);
      const existingNameKeys = new Set(
        existingBranches
          .filter((branch) => branch.status !== "DELETED")
          .map((branch) => toNameKey(branch.name))
      );

      const namesInRequest = new Set<string>();
      for (const item of dto.branches) {
        const nameKey = toNameKey(item.name);
        if (existingNameKeys.has(nameKey)) {
          throw CustomError.conflict("Ya existe una sede con este nombre en este negocio");
        }
        if (namesInRequest.has(nameKey)) {
          throw CustomError.conflict("Nombre de sede duplicado en la solicitud");
        }
        namesInRequest.add(nameKey);
      }

      const created: Branch[] = [];
      for (const item of dto.branches) {
        await this.businessUsageLimitService.consume(dto.businessId, "branches", 1);
        try {
          const data = {
            businessId: dto.businessId,
            name: item.name,
            address: item.address,
            location: item.location,
            phone: item.phone,
            phoneHasWhatsapp: item.phoneHasWhatsapp,
            schedule: item.schedule,
            imageGallery: item.imageGallery,
            status: "ACTIVE" as const,
            createdAt: FirestoreDataBase.generateTimeStamp(),
          };
          const result = await FirestoreService.create(COLLECTION_NAME, data);
          created.push(result);
        } catch (error) {
          await this.businessUsageLimitService.release(dto.businessId, "branches", 1).catch(() => undefined);
          throw error;
        }
      }
      return created;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updateBranch(id: string, dto: UpdateBranchBodyDto): Promise<Branch> {
    try {
      const branches = await FirestoreService.getAll<Branch>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (branches.length === 0) throw CustomError.notFound("No existe una sede con este id");
      const branch = branches[0]!;

      if (dto.name !== undefined) {
        const nameKey = toNameKey(dto.name);
        const currentNameKey = toNameKey(branch.name);

        if (nameKey !== currentNameKey) {
          const existingBranches = await FirestoreService.getAll<Branch>(COLLECTION_NAME, [
            { field: "businessId", operator: "==", value: branch.businessId },
          ]);
          const nameTaken = existingBranches.some(
            (b) =>
              b.status !== "DELETED" &&
              b.id !== id &&
              toNameKey(b.name) === nameKey
          );
          if (nameTaken) {
            throw CustomError.conflict("Ya existe una sede con este nombre en este negocio");
          }
        }
      }

      const isRestoringDeletedBranch =
        branch.status === "DELETED" &&
        (dto.status === "ACTIVE" || dto.status === "INACTIVE");
      if (branch.status === "DELETED" && !isRestoringDeletedBranch) {
        throw CustomError.badRequest(
          "No se puede editar una sede eliminada sin reactivarla"
        );
      }

      if (!areSchedulesEquivalent(branch.schedule, dto.schedule)) {
        await this.schedulingIntegrityService.ensureActiveAppointmentsRespectBranchSchedule(
          {
            branchId: branch.id,
            schedule: dto.schedule,
            errorMessagePrefix:
              "No se puede actualizar el horario de la sede porque hay citas activas fuera del nuevo horario",
          }
        );
      }

      const payload: Record<string, unknown> = {
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };
      if (dto.name !== undefined) payload.name = dto.name;
      if (dto.address !== undefined) payload.address = dto.address;
      payload.location = dto.location;
      payload.phone = dto.phone;
      payload.phoneHasWhatsapp = dto.phoneHasWhatsapp;
      payload.schedule = dto.schedule;
      payload.imageGallery = dto.imageGallery;
      if (dto.status !== undefined) payload.status = dto.status;
      if (isRestoringDeletedBranch) {
        payload.deletedAt = null;
        await this.businessUsageLimitService.consume(branch.businessId, "branches", 1);
        try {
          await FirestoreService.update(COLLECTION_NAME, id, payload);
        } catch (error) {
          await this.businessUsageLimitService.release(branch.businessId, "branches", 1).catch(
            () => undefined
          );
          throw error;
        }
      } else {
        await FirestoreService.update(COLLECTION_NAME, id, payload);
      }
      return await FirestoreService.getById<Branch>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteBranch(id: string): Promise<Branch> {
    try {
      const branches = await FirestoreService.getAll<Branch>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (branches.length === 0) throw CustomError.notFound("No existe una sede con este id");
      const branch = branches[0]!;
      await this.schedulingIntegrityService.ensureBranchCanBeDeleted(branch.id);
      const payload = {
        status: "DELETED" as const,
        deletedAt: FirestoreDataBase.generateTimeStamp(),
      };
      await FirestoreService.update(COLLECTION_NAME, id, payload);
      await Promise.all([
        this.deleteBranchStorageFolder(branch),
        this.clearMembershipBranchAssignments(branch.id),
        this.metricService.deleteBranchMetrics(branch.id),
        this.reviewService.deleteReviewsByBranchId(branch.id, {
          skipBranchScoreUpdate: true,
        }),
        this.businessUsageLimitService.release(branch.businessId, "branches", 1),
      ]);
      return await FirestoreService.getById<Branch>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async deleteBranchStorageFolder(branch: Branch): Promise<void> {
    const storagePrefix = `bussinesses/${branch.businessId}/branches/${slugFromName(branch.name)}/`;
    try {
      const bucket = FirestoreDataBase.getAdmin().storage().bucket();
      await bucket.deleteFiles({ prefix: storagePrefix });
    } catch (error) {
      if (shouldSkipStorageCleanup(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[BranchService] Se omite la limpieza de storage de la sede ${branch.id} porque no hay bucket configurado o válido. detalle=${detail}`
        );
        return;
      }
      throw error;
    }
  }

  private async clearMembershipBranchAssignments(branchId: string): Promise<void> {
    const memberships = await FirestoreService.getAll<BusinessMembership>(
      BUSINESS_MEMBERSHIPS_COLLECTION,
      [{ field: "branchId", operator: "==", value: branchId }]
    );

    await Promise.all(
      memberships.map((membership) =>
        FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membership.id, {
          branchId: null,
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        })
      )
    );
  }
}
