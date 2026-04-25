import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import type { Plan } from "../../domain/interfaces/plan.interface";
import type { Usage } from "../../domain/interfaces/usage.interface";
import type { FirestoreTransactionContext } from "./firestore-consistency.service";
import { BusinessUsageService } from "./business-usage.service";

const BUSINESS_COLLECTION = "Businesses";
const USAGE_SUBCOLLECTION = "usage";
const PLAN_COLLECTION = "Plans";

export type BusinessUsageQuotaResource =
  | "employees"
  | "branches"
  | "bookings"
  | "roles";

type UsageField = "maxEmployees" | "maxBranches" | "maxBookings" | "maxRoles";

function resolveUsageField(resource: BusinessUsageQuotaResource): UsageField {
  switch (resource) {
    case "employees":
      return "maxEmployees";
    case "branches":
      return "maxBranches";
    case "bookings":
      return "maxBookings";
    case "roles":
      return "maxRoles";
    default:
      return "maxEmployees";
  }
}

function resolveUsageLimitReachedMessage(
  resource: BusinessUsageQuotaResource
): string {
  switch (resource) {
    case "employees":
      return "El negocio alcanzó el límite de colaboradores de su plan actual";
    case "branches":
      return "El negocio alcanzó el límite de sedes de su plan actual";
    case "bookings":
      return "El negocio alcanzó el límite de agendamientos de su plan actual";
    case "roles":
      return "El negocio alcanzó el límite de roles de su plan actual";
    default:
      return "El negocio alcanzó el límite de recursos de su plan actual";
  }
}

export class BusinessUsageLimitService {
  constructor(
    private readonly businessUsageService: BusinessUsageService =
      new BusinessUsageService()
  ) {}

  async syncUsageStateForToday(businessId: string): Promise<void> {
    const normalizedBusinessId = businessId.trim();
    if (normalizedBusinessId === "") {
      throw CustomError.badRequest("businessId es requerido para sincronizar cupos");
    }

    await this.businessUsageService.syncUsageStateForToday(normalizedBusinessId);
  }

  async consume(
    businessId: string,
    resource: BusinessUsageQuotaResource,
    amount = 1
  ): Promise<void> {
    const normalizedBusinessId = businessId.trim();
    if (normalizedBusinessId === "") {
      throw CustomError.badRequest("businessId es requerido para consumir cupos");
    }

    await this.syncUsageStateForToday(normalizedBusinessId);

    const normalizedAmount = Math.max(1, Math.floor(amount));
    const db = FirestoreDataBase.getDB();

    await db.runTransaction(async (transaction) => {
      await this.consumeWithinTransaction(
        {
          db,
          transaction,
          now: FirestoreDataBase.generateTimeStamp(),
          doc: (collectionName: string, id?: string) =>
            id != null && id.trim() !== ""
              ? db.collection(collectionName).doc(id)
              : db.collection(collectionName).doc(),
          subdoc: (
            parentCollection: string,
            parentId: string,
            subcollectionName: string,
            id?: string
          ) =>
            id != null && id.trim() !== ""
              ? db
                  .collection(parentCollection)
                  .doc(parentId)
                  .collection(subcollectionName)
                  .doc(id)
              : db
                  .collection(parentCollection)
                  .doc(parentId)
                  .collection(subcollectionName)
                  .doc(),
        },
        normalizedBusinessId,
        resource,
        normalizedAmount
      );
    });
  }

  async consumeInTransaction(
    context: FirestoreTransactionContext,
    businessId: string,
    resource: BusinessUsageQuotaResource,
    amount = 1
  ): Promise<void> {
    const normalizedBusinessId = businessId.trim();
    if (normalizedBusinessId === "") {
      throw CustomError.badRequest("businessId es requerido para consumir cupos");
    }

    const normalizedAmount = Math.max(1, Math.floor(amount));
    await this.consumeWithinTransaction(
      context,
      normalizedBusinessId,
      resource,
      normalizedAmount
    );
  }

  private async consumeWithinTransaction(
    context: FirestoreTransactionContext,
    businessId: string,
    resource: BusinessUsageQuotaResource,
    amount: number
  ): Promise<void> {
    const usageField = resolveUsageField(resource);
    const businessRef = context.doc(BUSINESS_COLLECTION, businessId);
    const businessSnapshot = await context.transaction.get(businessRef);
    if (!businessSnapshot.exists) {
      throw CustomError.notFound("No existe un negocio con este id");
    }

    const business = businessSnapshot.data() as Business;
    if (business.status === "DELETED") {
      throw CustomError.badRequest("No se puede consumir cupos de un negocio eliminado");
    }
    if (business.status !== "ACTIVE") {
      throw CustomError.forbidden(
        "El negocio está inactivo y no puede operar en este momento",
        "BUSINESS_INACTIVE"
      );
    }
    if ((business.subscriptionStatus ?? "INACTIVE") !== "ACTIVE") {
      throw CustomError.forbidden(
        "El plan del negocio está vencido o inactivo. Renueva o reactiva el plan para continuar",
        "BUSINESS_SUBSCRIPTION_INACTIVE"
      );
    }

    const usageQuery = businessRef
      .collection(USAGE_SUBCOLLECTION)
      .where("status", "==", "ACTIVE")
      .limit(2);
    const usageSnapshots = await context.transaction.get(usageQuery);

    if (usageSnapshots.empty) {
      throw CustomError.forbidden(
        "El plan del negocio está vencido o inactivo. Renueva o reactiva el plan para continuar",
        "BUSINESS_SUBSCRIPTION_INACTIVE"
      );
    }
    if (usageSnapshots.size > 1) {
      throw CustomError.conflict("Se detectaron múltiples registros de uso activos para el negocio");
    }

    const usageSnapshot = usageSnapshots.docs[0]!;
    const usage = usageSnapshot.data() as Usage;
    const currentValue = Math.max(0, Number(usage[usageField] ?? 0));

    if (currentValue < amount) {
      throw CustomError.conflict(
        resolveUsageLimitReachedMessage(resource),
        "BUSINESS_PLAN_LIMIT_REACHED"
      );
    }

    context.transaction.update(usageSnapshot.ref, {
      [usageField]: currentValue - amount,
    });
  }

  async release(
    businessId: string,
    resource: BusinessUsageQuotaResource,
    amount = 1
  ): Promise<void> {
    const normalizedBusinessId = businessId.trim();
    if (normalizedBusinessId === "") {
      return;
    }

    const normalizedAmount = Math.max(1, Math.floor(amount));
    const usageField = resolveUsageField(resource);
    const db = FirestoreDataBase.getDB();

    await db.runTransaction(async (transaction) => {
      const businessRef = db.collection(BUSINESS_COLLECTION).doc(normalizedBusinessId);
      const businessSnapshot = await transaction.get(businessRef);
      if (!businessSnapshot.exists) {
        return;
      }

      const usageQuery = businessRef
        .collection(USAGE_SUBCOLLECTION)
        .where("status", "==", "ACTIVE")
        .limit(2);
      const usageSnapshots = await transaction.get(usageQuery);

      if (usageSnapshots.empty) {
        return;
      }
      if (usageSnapshots.size > 1) {
        throw CustomError.conflict("Se detectaron múltiples registros de uso activos para el negocio");
      }

      const usageSnapshot = usageSnapshots.docs[0]!;
      const usage = usageSnapshot.data() as Usage;
      const currentValue = Math.max(0, Number(usage[usageField] ?? 0));
      const planId = typeof usage.planId === "string" ? usage.planId.trim() : "";
      let maxAllowedValue: number | null = null;

      if (planId !== "") {
        const planSnapshot = await transaction.get(
          db.collection(PLAN_COLLECTION).doc(planId)
        );
        if (planSnapshot.exists) {
          const plan = planSnapshot.data() as Plan;
          maxAllowedValue = Math.max(
            0,
            Number(this.resolvePlanLimitValue(plan, resource))
          );
        }
      }

      const nextValue =
        maxAllowedValue == null
          ? currentValue + normalizedAmount
          : Math.min(maxAllowedValue, currentValue + normalizedAmount);

      transaction.update(usageSnapshot.ref, {
        [usageField]: nextValue,
      });
    });

    await this.businessUsageService
      .syncUsageStateForToday(normalizedBusinessId)
      .catch(() => undefined);
  }

  private resolvePlanLimitValue(
    plan: Plan,
    resource: BusinessUsageQuotaResource
  ): number {
    switch (resource) {
      case "employees":
        return plan.maxEmployees;
      case "branches":
        return plan.maxBranches;
      case "bookings":
        return plan.maxBookings;
      case "roles":
        return plan.maxRoles;
      default:
        return plan.maxEmployees;
    }
  }
}
