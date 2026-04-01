import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import { BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES } from "../../domain/interfaces/business-membership.interface";
import type { Plan } from "../../domain/interfaces/plan.interface";
import type { Usage } from "../../domain/interfaces/usage.interface";
import type { Query } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "../../infrastructure/logger/logger";
import {
  addDays,
  buildUsagePeriods,
  getCurrentBogotaDate,
  isDateWithinPeriod,
  normalizeBillingInterval,
} from "../../domain/utils/usage-period.utils";

const BUSINESS_COLLECTION = "Businesses";
const PLAN_COLLECTION = "Plans";
const USAGE_SUBCOLLECTION = "usage";
const BUSINESS_MEMBERSHIP_COLLECTION = "BusinessMemberships";
const BRANCH_COLLECTION = "Branches";
const BOOKINGS_COLLECTION = "Bookings";
const ROLE_COLLECTION = "Roles";

type ManagedUsage = Usage & {
  nextStatusChangeDate?: string | null;
};

type UsageRecord = ManagedUsage & { id: string };

interface ResourceCounts {
  employees: number;
  branches: number;
  bookings: number;
  roles: number;
}

function clampAvailable(limit: number, currentCount: number): number {
  return Math.max(0, limit - currentCount);
}

export class BusinessUsageService {
  async ensurePlanExists(planId: string): Promise<Plan> {
    const normalizedPlanId = planId.trim();
    if (normalizedPlanId === "") {
      throw CustomError.badRequest("planId es requerido");
    }

    const plan = await FirestoreDataBase.getDB()
      .collection(PLAN_COLLECTION)
      .doc(normalizedPlanId)
      .get();

    if (!plan.exists) {
      throw CustomError.notFound("No existe un plan con este id");
    }

    const data = plan.data() as Plan & { billingInterval?: Plan["billingInterval"] | "QUATERLY" };
    return {
      ...data,
      id: plan.id,
      billingInterval: normalizeBillingInterval(
        (data.billingInterval ?? "MONTHLY") as Plan["billingInterval"] | "QUATERLY"
      ),
    };
  }

  async getUsages(businessId: string): Promise<UsageRecord[]> {
    const normalizedBusinessId = businessId.trim();
    if (normalizedBusinessId === "") {
      return [];
    }

    const snapshot = await FirestoreDataBase.getDB()
      .collection(BUSINESS_COLLECTION)
      .doc(normalizedBusinessId)
      .collection(USAGE_SUBCOLLECTION)
      .get();

    return snapshot.docs
      .map((doc) => {
        const data = doc.data() as Usage;
        return {
          ...data,
          id: doc.id,
        };
      })
      .sort((a, b) => a.startPeriod.localeCompare(b.startPeriod));
  }

  async rebuildBusinessUsage(input: {
    businessId: string;
    planId: string;
    startPeriods: string[];
  }): Promise<{ subscriptionStatus: Business["subscriptionStatus"]; usages: UsageRecord[] }> {
    const businessId = input.businessId.trim();
    if (businessId === "") {
      throw CustomError.badRequest("businessId es requerido");
    }

    const plan = await this.ensurePlanExists(input.planId);
    const periods = buildUsagePeriods(input.startPeriods, plan.billingInterval);
    const today = getCurrentBogotaDate();
    const activePeriod =
      periods.find((period) => isDateWithinPeriod(today, period.startPeriod, period.endPeriod)) ??
      null;
    const [existingUsages, activeUsageCounts] = await Promise.all([
      this.getUsages(businessId),
      activePeriod != null
        ? this.loadCurrentResourceCounts({
            businessId,
            bookingStartPeriod: activePeriod.startPeriod,
            bookingEndPeriod: today,
          })
        : Promise.resolve(null),
    ]);
    const activeUsageRemaining =
      activeUsageCounts != null ? this.buildRemainingQuota(activeUsageCounts, plan) : null;

    const usages = periods.map(({ startPeriod, endPeriod }) => {
      const isActive = isDateWithinPeriod(today, startPeriod, endPeriod);
      const remaining =
        isActive && activeUsageRemaining != null
          ? activeUsageRemaining
          : this.buildPlanQuota(plan);

      return {
        id: startPeriod,
        ...remaining,
        planId: plan.id,
        startPeriod,
        endPeriod,
        status: isActive ? "ACTIVE" : "INACTIVE",
        nextStatusChangeDate: this.resolveNextStatusChangeDate(
          isActive ? "ACTIVE" : "INACTIVE",
          startPeriod,
          endPeriod,
          today
        ),
      } satisfies UsageRecord;
    });

    const subscriptionStatus: Business["subscriptionStatus"] = usages.some(
      (usage) => usage.status === "ACTIVE"
    )
      ? "ACTIVE"
      : "INACTIVE";

    const db = FirestoreDataBase.getDB();
    const businessRef = db.collection(BUSINESS_COLLECTION).doc(businessId);
    const batch = db.batch();

    for (const usage of existingUsages) {
      batch.delete(businessRef.collection(USAGE_SUBCOLLECTION).doc(usage.id));
    }

    for (const usage of usages) {
      batch.set(businessRef.collection(USAGE_SUBCOLLECTION).doc(usage.id), {
        maxEmployees: usage.maxEmployees,
        maxBranches: usage.maxBranches,
        maxBookings: usage.maxBookings,
        maxRoles: usage.maxRoles,
        planId: usage.planId,
        startPeriod: usage.startPeriod,
        endPeriod: usage.endPeriod,
        status: usage.status,
        nextStatusChangeDate: usage.nextStatusChangeDate ?? null,
      });
    }

    batch.update(businessRef, {
      planId: plan.id,
      subscriptionStatus,
      updatedAt: FirestoreDataBase.generateTimeStamp(),
    });

    await batch.commit();

    return { subscriptionStatus, usages };
  }

  async deleteBusinessUsage(businessId: string): Promise<void> {
    const usages = await this.getUsages(businessId);

    const db = FirestoreDataBase.getDB();
    const businessRef = db.collection(BUSINESS_COLLECTION).doc(businessId);
    const batch = db.batch();
    for (const usage of usages) {
      batch.delete(businessRef.collection(USAGE_SUBCOLLECTION).doc(usage.id));
    }
    await batch.commit();
  }

  async syncUsageStateForToday(businessId: string): Promise<{
    changed: boolean;
    subscriptionStatus: Business["subscriptionStatus"];
    activeUsageId: string | null;
  }> {
    const normalizedBusinessId = businessId.trim();
    if (normalizedBusinessId === "") {
      throw CustomError.badRequest("businessId es requerido");
    }

    const businessRef = FirestoreDataBase.getDB()
      .collection(BUSINESS_COLLECTION)
      .doc(normalizedBusinessId);
    const businessSnapshot = await businessRef.get();
    if (!businessSnapshot.exists) {
      return {
        changed: false,
        subscriptionStatus: "INACTIVE",
        activeUsageId: null,
      };
    }

    const business = businessSnapshot.data() as Business;
    if (business.status === "DELETED") {
      return {
        changed: false,
        subscriptionStatus: business.subscriptionStatus ?? "INACTIVE",
        activeUsageId: null,
      };
    }

    const usages = await this.getUsages(normalizedBusinessId);
    const today = getCurrentBogotaDate();
    const candidateActiveUsages = usages.filter((usage) =>
      isDateWithinPeriod(today, usage.startPeriod, usage.endPeriod)
    );
    const activeUsage = candidateActiveUsages.sort((a, b) =>
      a.startPeriod.localeCompare(b.startPeriod)
    )[0] ?? null;

    const resourceCounts =
      activeUsage != null
        ? await this.loadCurrentResourceCounts({
            businessId: normalizedBusinessId,
            bookingStartPeriod: activeUsage.startPeriod,
            bookingEndPeriod: today,
          })
        : null;
    const activePlan =
      activeUsage != null ? await this.ensurePlanExists(activeUsage.planId) : null;

    const batch = FirestoreDataBase.getDB().batch();
    let changed = false;

    for (const usage of usages) {
      const shouldBeActive = activeUsage != null && usage.id === activeUsage.id;
      const nextStatus: Usage["status"] = shouldBeActive ? "ACTIVE" : "INACTIVE";
      const nextStatusChangeDate = this.resolveNextStatusChangeDate(
        nextStatus,
        usage.startPeriod,
        usage.endPeriod,
        today
      );
      const payload: Record<string, unknown> = {};

      if (usage.status !== nextStatus) {
        payload.status = nextStatus;
      }

      if ((usage.nextStatusChangeDate ?? null) !== nextStatusChangeDate) {
        payload.nextStatusChangeDate = nextStatusChangeDate;
      }

      if (shouldBeActive && activePlan && resourceCounts) {
        const remaining = this.buildRemainingQuota(resourceCounts, activePlan);
        if (usage.maxEmployees !== remaining.maxEmployees) {
          payload.maxEmployees = remaining.maxEmployees;
        }
        if (usage.maxBranches !== remaining.maxBranches) {
          payload.maxBranches = remaining.maxBranches;
        }
        if (usage.maxBookings !== remaining.maxBookings) {
          payload.maxBookings = remaining.maxBookings;
        }
        if (usage.maxRoles !== remaining.maxRoles) {
          payload.maxRoles = remaining.maxRoles;
        }
      }

      if (Object.keys(payload).length > 0) {
        changed = true;
        batch.update(
          businessRef.collection(USAGE_SUBCOLLECTION).doc(usage.id),
          payload
        );
      }
    }

    const subscriptionStatus: Business["subscriptionStatus"] =
      activeUsage != null ? "ACTIVE" : "INACTIVE";
    if (business.subscriptionStatus !== subscriptionStatus) {
      changed = true;
      batch.update(businessRef, {
        subscriptionStatus,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });
    }

    if (changed) {
      await batch.commit();
    }

    return {
      changed,
      subscriptionStatus,
      activeUsageId: activeUsage?.id ?? null,
    };
  }

  async reconcileDueUsageTransitionsForToday(): Promise<{
    date: string;
    candidateUsageCount: number;
    processedBusinesses: number;
    changedBusinesses: number;
    failedBusinesses: string[];
  }> {
    const today = getCurrentBogotaDate();
    const yesterday = addDays(today, -1);
    const db = FirestoreDataBase.getDB();
    const [dueSnapshot, activationSnapshot, deactivationSnapshot] =
      await Promise.all([
        db
          .collectionGroup(USAGE_SUBCOLLECTION)
          .where("nextStatusChangeDate", "<=", today)
          .get()
          .catch((error: unknown) => {
            this.logUsageReconcileQueryError({
              error,
              queryName: "dueSnapshot",
              filters: [["nextStatusChangeDate", "<=", today]],
            });
            throw error;
          }),
        db
          .collectionGroup(USAGE_SUBCOLLECTION)
          .where("startPeriod", "==", today)
          .get()
          .catch((error: unknown) => {
            this.logUsageReconcileQueryError({
              error,
              queryName: "activationSnapshot",
              filters: [["startPeriod", "==", today]],
            });
            throw error;
          }),
        db
          .collectionGroup(USAGE_SUBCOLLECTION)
          .where("endPeriod", "==", yesterday)
          .get()
          .catch((error: unknown) => {
            this.logUsageReconcileQueryError({
              error,
              queryName: "deactivationSnapshot",
              filters: [["endPeriod", "==", yesterday]],
            });
            throw error;
          }),
      ]);

    const businessIds = Array.from(
      new Set(
        [
          ...dueSnapshot.docs,
          ...activationSnapshot.docs,
          ...deactivationSnapshot.docs,
        ]
          .map((doc) => doc.ref.parent.parent?.id?.trim() ?? "")
          .filter((businessId) => businessId !== "")
      )
    );

    if (businessIds.length === 0) {
      return {
        date: today,
        candidateUsageCount: 0,
        processedBusinesses: 0,
        changedBusinesses: 0,
        failedBusinesses: [],
      };
    }

    let changedBusinesses = 0;
    const failedBusinesses: string[] = [];
    const chunkSize = 20;

    for (let index = 0; index < businessIds.length; index += chunkSize) {
      const chunk = businessIds.slice(index, index + chunkSize);
      const results = await Promise.allSettled(
        chunk.map(async (businessId) => {
          const result = await this.syncUsageStateForToday(businessId);
          return { businessId, changed: result.changed };
        })
      );

      results.forEach((result, resultIndex) => {
        const businessId = chunk[resultIndex]!;
        if (result.status === "fulfilled") {
          if (result.value.changed) {
            changedBusinesses += 1;
          }
          return;
        }

        failedBusinesses.push(businessId);
      });
    }

    return {
      date: today,
      candidateUsageCount:
        dueSnapshot.size + activationSnapshot.size + deactivationSnapshot.size,
      processedBusinesses: businessIds.length,
      changedBusinesses,
      failedBusinesses,
    };
  }

  private async loadCurrentResourceCounts(input: {
    businessId: string;
    bookingStartPeriod: string;
    bookingEndPeriod: string;
  }): Promise<ResourceCounts> {
    const db = FirestoreDataBase.getDB();
    const bookingStartBoundary = this.buildBogotaDayStartTimestamp(input.bookingStartPeriod);
    const bookingEndBoundaryExclusive = this.buildBogotaDayStartTimestamp(
      addDays(input.bookingEndPeriod, 1)
    );

    const [employeeCount, branchCount, bookingCount, roleCount] = await Promise.all([
      this.countQueryWithFallback({
        description: "business employees usage count",
        countQuery: db
          .collection(BUSINESS_MEMBERSHIP_COLLECTION)
          .where("businessId", "==", input.businessId)
          .where("isEmployee", "==", true)
          .where("status", "in", [...BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES]),
        fallbackQuery: db
          .collection(BUSINESS_MEMBERSHIP_COLLECTION)
          .where("businessId", "==", input.businessId)
          .select("isEmployee", "status"),
        predicate: (data) =>
          data.isEmployee === true &&
          typeof data.status === "string" &&
          BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES.includes(
            data.status as (typeof BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES)[number]
          ),
      }),
      this.countQueryWithFallback({
        description: "business branches usage count",
        countQuery: db
          .collection(BRANCH_COLLECTION)
          .where("businessId", "==", input.businessId)
          .where("status", "in", ["ACTIVE", "INACTIVE"]),
        fallbackQuery: db
          .collection(BRANCH_COLLECTION)
          .where("businessId", "==", input.businessId)
          .select("status"),
        predicate: (data) => data.status === "ACTIVE" || data.status === "INACTIVE",
      }),
      this.countQueryWithFallback({
        description: "business bookings usage count",
        countQuery: db
          .collection(BOOKINGS_COLLECTION)
          .where("businessId", "==", input.businessId)
          .where("status", "in", ["CREATED", "CANCELLED", "FINISHED"])
          .where("createdAt", ">=", bookingStartBoundary)
          .where("createdAt", "<", bookingEndBoundaryExclusive),
        fallbackQuery: db
          .collection(BOOKINGS_COLLECTION)
          .where("businessId", "==", input.businessId)
          .select("status", "createdAt"),
        predicate: (data) =>
          (data.status === "CREATED" ||
            data.status === "CANCELLED" ||
            data.status === "FINISHED") &&
          this.isTimestampWithinRange(
            data.createdAt,
            bookingStartBoundary,
            bookingEndBoundaryExclusive
          ),
      }),
      this.countQueryWithFallback({
        description: "business roles usage count",
        countQuery: db
          .collection(ROLE_COLLECTION)
          .where("businessId", "==", input.businessId)
          .where("type", "==", "CUSTOM"),
        fallbackQuery: db
          .collection(ROLE_COLLECTION)
          .where("businessId", "==", input.businessId)
          .select("type"),
        predicate: (data) => data.type === "CUSTOM",
      }),
    ]);

    return {
      employees: employeeCount,
      branches: branchCount,
      bookings: bookingCount,
      roles: roleCount,
    };
  }

  private buildRemainingQuota(
    counts: ResourceCounts,
    plan: Plan
  ): Pick<Usage, "maxEmployees" | "maxBranches" | "maxBookings" | "maxRoles"> {
    return {
      maxEmployees: clampAvailable(plan.maxEmployees, counts.employees),
      maxBranches: clampAvailable(plan.maxBranches, counts.branches),
      maxBookings: clampAvailable(plan.maxBookings, counts.bookings),
      maxRoles: clampAvailable(plan.maxRoles, counts.roles),
    };
  }

  private buildPlanQuota(
    plan: Plan
  ): Pick<Usage, "maxEmployees" | "maxBranches" | "maxBookings" | "maxRoles"> {
    return {
      maxEmployees: Math.max(0, plan.maxEmployees),
      maxBranches: Math.max(0, plan.maxBranches),
      maxBookings: Math.max(0, plan.maxBookings),
      maxRoles: Math.max(0, plan.maxRoles),
    };
  }

  private async countQuery(query: Query): Promise<number> {
    const countAggregate = (
      query as Query & {
        count(): { get(): Promise<{ data(): { count: number } }> };
      }
    ).count();
    const snapshot = await countAggregate.get();
    return snapshot.data().count;
  }

  private async countQueryWithFallback(input: {
    description: string;
    countQuery: Query;
    fallbackQuery: Query;
    predicate: (data: Record<string, unknown>) => boolean;
  }): Promise<number> {
    try {
      return await this.countQuery(input.countQuery);
    } catch (error) {
      if (!this.shouldFallbackToInMemoryCount(error)) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[BusinessUsageService] Falling back to in-memory count for ${input.description}. detalle=${reason}`
      );

      const snapshot = await input.fallbackQuery.get();
      return snapshot.docs.reduce((count, doc) => {
        const data = doc.data() as Record<string, unknown>;
        return input.predicate(data) ? count + 1 : count;
      }, 0);
    }
  }

  private shouldFallbackToInMemoryCount(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error != null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";

    return (
      code === "failed-precondition" ||
      code === "9" ||
      message.includes("FAILED_PRECONDITION") ||
      message.toLowerCase().includes("requires an index") ||
      message.toLowerCase().includes("index")
    );
  }

  private logUsageReconcileQueryError(input: {
    error: unknown;
    queryName: string;
    filters: Array<[string, string, string]>;
  }): void {
    const errorObject =
      typeof input.error === "object" && input.error != null
        ? (input.error as Record<string, unknown>)
        : null;

    logger.error(
      `[BusinessUsageService] reconcileDueUsageTransitionsForToday query failed. ${JSON.stringify({
        queryName: input.queryName,
        collectionGroup: USAGE_SUBCOLLECTION,
        filters: input.filters,
        message: input.error instanceof Error ? input.error.message : String(input.error),
        code: errorObject?.code ?? null,
        details: errorObject?.details ?? null,
        metadata: errorObject?.metadata ?? null,
        error: errorObject,
      })}`
    );
  }

  private isTimestampWithinRange(
    value: unknown,
    startInclusive: Timestamp,
    endExclusive: Timestamp
  ): boolean {
    const millis = this.resolveTimestampMillis(value);
    if (millis == null) {
      return false;
    }

    return millis >= startInclusive.toMillis() && millis < endExclusive.toMillis();
  }

  private resolveTimestampMillis(value: unknown): number | null {
    if (value instanceof Timestamp) {
      return value.toMillis();
    }

    if (
      typeof value === "object" &&
      value != null &&
      "toDate" in value &&
      typeof (value as { toDate?: unknown }).toDate === "function"
    ) {
      const date = (value as { toDate(): Date }).toDate();
      return Number.isNaN(date.getTime()) ? null : date.getTime();
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }

    return null;
  }

  private buildBogotaDayStartTimestamp(date: string): Timestamp {
    return Timestamp.fromDate(new Date(`${date}T00:00:00.000-05:00`));
  }

  private resolveNextStatusChangeDate(
    status: Usage["status"],
    startPeriod: string,
    endPeriod: string,
    today: string
  ): string | null {
    if (status === "ACTIVE") {
      return addDays(endPeriod, 1);
    }

    if (today < startPeriod) {
      return startPeriod;
    }

    return null;
  }
}
