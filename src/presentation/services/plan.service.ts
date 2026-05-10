import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { PaginatedResult, PaginationParams } from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import type { Plan } from "../../domain/interfaces/plan.interface";
import { getCurrentBogotaDate, normalizeBillingInterval } from "../../domain/utils/usage-period.utils";
import type { CreatePlanDto } from "../plan/dtos/create-plan.dto";
import type { UpdatePlanDto } from "../plan/dtos/update-plan.dto";
import { BusinessUsageService } from "./business-usage.service";
import FirestoreService from "./firestore.service";

const COLLECTION_NAME = "Plans";
const BUSINESS_COLLECTION = "Businesses";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

export class PlanService {
  constructor(
    private readonly businessUsageService: BusinessUsageService = new BusinessUsageService()
  ) {}

  async getAllPlans(
    params: PaginationParams & { id?: string; status?: Plan["status"] }
  ): Promise<PaginatedResult<Plan>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const filters = [
        ...(params.id != null && params.id.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.id.trim() }]
          : []),
        ...(params.status != null
          ? [{ field: "status" as const, operator: "==" as const, value: params.status }]
          : []),
      ];

      const result = await FirestoreService.getAllPaginated<Plan>(
        COLLECTION_NAME,
        { page, pageSize },
        filters
      );
      return {
        ...result,
        data: result.data.map((plan) => this.normalizePlan(plan)),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createPlan(dto: CreatePlanDto): Promise<Plan> {
    try {
      await this.ensureNameAvailable(dto.name);

      const result = await FirestoreService.create(COLLECTION_NAME, {
        name: dto.name,
        description: dto.description,
        status: dto.status,
        billingInterval: dto.billingInterval,
        maxEmployees: dto.maxEmployees,
        maxBranches: dto.maxBranches,
        maxBookings: dto.maxBookings,
        maxRoles: dto.maxRoles,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });

      return this.normalizePlan(result as Plan);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updatePlan(id: string, dto: UpdatePlanDto): Promise<Plan> {
    try {
      const plans = await FirestoreService.getAll<Plan>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (plans.length === 0) {
        throw CustomError.notFound("No existe un plan con este id");
      }

      if (dto.name !== undefined) {
        await this.ensureNameAvailable(dto.name, id);
      }

      if (dto.status !== undefined && dto.status !== plans[0]!.status) {
        const blockingBusinessCount = await this.findBusinessesBlockingStatusChange(id);
        if (blockingBusinessCount > 0) {
          throw CustomError.conflict(
            `No se puede cambiar el estado del plan porque hay ${blockingBusinessCount} ${
              blockingBusinessCount === 1 ? "negocio" : "negocios"
            } con vigencia activa o futura asociad${
              blockingBusinessCount === 1 ? "o" : "os"
            } a este plan`
          );
        }
      }

      const payload: Record<string, unknown> = {
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };

      if (dto.name !== undefined) payload.name = dto.name;
      if (dto.description !== undefined) payload.description = dto.description;
      if (dto.status !== undefined) payload.status = dto.status;
      if (dto.maxEmployees !== undefined) payload.maxEmployees = dto.maxEmployees;
      if (dto.maxBranches !== undefined) payload.maxBranches = dto.maxBranches;
      if (dto.maxBookings !== undefined) payload.maxBookings = dto.maxBookings;
      if (dto.maxRoles !== undefined) payload.maxRoles = dto.maxRoles;

      await FirestoreService.update(COLLECTION_NAME, id, payload);
      return this.normalizePlan(
        await FirestoreService.getById<Plan>(COLLECTION_NAME, id)
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async getStatusChangeEligibility(
    id: string
  ): Promise<{ canChangeStatus: boolean; blockingBusinessCount: number }> {
    try {
      const plans = await FirestoreService.getAll<Plan>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (plans.length === 0) {
        throw CustomError.notFound("No existe un plan con este id");
      }

      const blockingBusinessCount = await this.findBusinessesBlockingStatusChange(id);
      return {
        canChangeStatus: blockingBusinessCount === 0,
        blockingBusinessCount,
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async findBusinessesBlockingStatusChange(planId: string): Promise<number> {
    const businessesUsingPlan = await FirestoreService.getAll<{
      id: string;
      status: string;
    }>(BUSINESS_COLLECTION, [
      { field: "planId", operator: "==", value: planId },
    ]);
    const today = getCurrentBogotaDate();
    let blockingCount = 0;

    for (const business of businessesUsingPlan) {
      if (business.status === "DELETED") continue;
      const usages = await this.businessUsageService.getUsages(business.id);
      const hasActiveOrFuturePeriod = usages.some(
        (usage) => usage.endPeriod >= today || usage.startPeriod > today
      );
      if (hasActiveOrFuturePeriod) {
        blockingCount += 1;
      }
    }

    return blockingCount;
  }

  async deletePlan(id: string): Promise<{ id: string; message: string }> {
    try {
      const plans = await FirestoreService.getAll<Plan>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (plans.length === 0) {
        throw CustomError.notFound("No existe un plan con este id");
      }

      const businessesUsingPlan = await FirestoreService.getAll<{
        status: string;
      }>(BUSINESS_COLLECTION, [{ field: "planId", operator: "==", value: id }]);
      const hasActiveUsage = businessesUsingPlan.some(
        (business) => business.status !== "DELETED"
      );
      if (hasActiveUsage) {
        throw CustomError.conflict(
          "No se puede eliminar el plan porque hay negocios que lo están usando"
        );
      }

      return await FirestoreService.delete(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async ensureNameAvailable(name: string, excludedId?: string): Promise<void> {
    const existingPlans = await FirestoreService.getAll<Plan>(COLLECTION_NAME);
    const incomingNameKey = toNameKey(name);
    const duplicated = existingPlans.some(
      (plan) => plan.id !== excludedId && toNameKey(plan.name) === incomingNameKey
    );

    if (duplicated) {
      throw CustomError.conflict("Ya existe un plan con este nombre");
    }
  }

  private normalizePlan(plan: Plan): Plan {
    return {
      ...plan,
      billingInterval: normalizeBillingInterval(
        (plan.billingInterval ?? "MONTHLY") as Plan["billingInterval"] | "QUATERLY"
      ),
    };
  }
}
