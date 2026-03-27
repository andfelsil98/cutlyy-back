import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { FieldValue } from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import {
  METRIC_TYPES,
  type MetricCalculationType,
} from "../../config/metric-types.config";
import type {
  Metric,
  MetricTimeFrame,
  MetricType,
} from "../../domain/interfaces/metric.interface";
import type { DbFilters } from "../../domain/interfaces/dbFilters.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import FirestoreService from "./firestore.service";

const COLLECTION_NAME = "Metrics";

interface MetricDeltas {
  revenueDelta: number;
  appointmentsDelta: number;
  completedAppointmentsDelta: number;
  cancelledAppointmentsDelta: number;
}

interface MetricIdentity {
  type: MetricType;
  businessId?: string;
  branchId?: string;
  employeeId?: string;
  date?: string;
  month?: string;
}

export interface ApplyAppointmentMetricDeltaInput {
  businessId: string;
  branchId: string;
  employeeId: string;
  date: string;
  revenueDelta?: number;
  appointmentsDelta?: number;
  completedAppointmentsDelta?: number;
  cancelledAppointmentsDelta?: number;
}

export interface GetMetricInsightsInput {
  metricTypes: MetricCalculationType[];
  entityType: MetricType;
  businessId?: string;
  branchId?: string;
  employeeId?: string;
  timeframe?: MetricTimeFrame;
  startDate?: string;
  endDate?: string;
  sameDate?: boolean;
}

interface MetricTotals {
  revenue: number;
  appointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
}

interface EmployeeProductivityItem {
  employeeId: string;
  revenue: number;
}

interface InsightPeriod {
  startDate?: string;
  endDate?: string;
  sameDate: boolean;
}

interface InsightFilterBuildResult {
  timeframe: MetricTimeFrame;
  period: InsightPeriod;
  baseFilters: DbFilters[];
  filters: DbFilters[];
}

export interface MetricInsightResult {
  type: MetricCalculationType;
  value: number | null | EmployeeProductivityItem[];
}

export interface MetricInsightsResponse {
  entityType: MetricType;
  entityId?: string;
  metricTypes: MetricCalculationType[];
  timeframe: MetricTimeFrame;
  period: {
    startDate?: string;
    endDate?: string;
    sameDate: boolean;
  };
  metrics: MetricInsightResult[];
}

export class MetricService {
  async deleteBranchMetrics(branchId: string): Promise<void> {
    const normalizedBranchId = branchId.trim();
    if (normalizedBranchId === "") return;

    const metrics = await FirestoreService.getAll<Metric>(COLLECTION_NAME, [
      { field: "type", operator: "==", value: "BRANCH" },
      { field: "branchId", operator: "==", value: normalizedBranchId },
    ]);

    await Promise.all(
      metrics.map((metric) => FirestoreService.delete(COLLECTION_NAME, metric.id))
    );
  }

  async getMetricInsights(input: GetMetricInsightsInput): Promise<MetricInsightsResponse> {
    const entityId = this.resolveOptionalEntityId(input);

    const { timeframe, period, baseFilters, filters } = this.buildInsightQueryFilters(
      input,
      entityId
    );

    const currentMetrics = await FirestoreService.getAll<Metric>(COLLECTION_NAME, filters);
    const totals = this.computeTotals(currentMetrics);

    const metrics: MetricInsightResult[] = [];
    for (const metricType of input.metricTypes) {
      if (metricType === METRIC_TYPES.REVENUE) {
        metrics.push({ type: metricType, value: totals.revenue });
        continue;
      }

      if (metricType === METRIC_TYPES.APPOINTMENTS_COUNT) {
        metrics.push({ type: metricType, value: totals.appointments });
        continue;
      }

      if (metricType === METRIC_TYPES.AVERAGE_TICKET) {
        const value =
          totals.completedAppointments <= 0
            ? 0
            : totals.revenue / totals.completedAppointments;
        metrics.push({ type: metricType, value });
        continue;
      }

      if (metricType === METRIC_TYPES.CANCELLATION_RATE) {
        const value =
          totals.appointments <= 0 ? 0 : totals.cancelledAppointments / totals.appointments;
        metrics.push({ type: metricType, value });
        continue;
      }

      if (metricType === METRIC_TYPES.COMPLETION_RATE) {
        const value =
          totals.appointments <= 0 ? 0 : totals.completedAppointments / totals.appointments;
        metrics.push({ type: metricType, value });
        continue;
      }

      if (metricType === METRIC_TYPES.EMPLOYEE_PRODUCTIVITY) {
        metrics.push({
          type: metricType,
          value: this.computeEmployeeProductivity(currentMetrics),
        });
        continue;
      }

      if (metricType === METRIC_TYPES.BUSINESS_GROWTH) {
        const value = await this.calculateBusinessGrowthByPreviousPeriod({
          timeframe,
          period,
          currentMetrics,
          currentRevenue: totals.revenue,
          baseFilters,
        });
        metrics.push({ type: metricType, value });
      }
    }

    return {
      entityType: input.entityType,
      ...(entityId != null && { entityId }),
      metricTypes: input.metricTypes,
      timeframe,
      period,
      metrics,
    };
  }

  async getAllMetrics(
    params: PaginationParams & {
      id?: string;
      type?: MetricType;
      businessId?: string;
      branchId?: string;
      employeeId?: string;
      date?: string;
      month?: string;
      timeFrame?: MetricTimeFrame;
    }
  ): Promise<PaginatedResult<Metric>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));

      const filters = [
        ...(params.id != null && params.id.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.id.trim() }]
          : []),
        ...(params.type != null
          ? [{ field: "type" as const, operator: "==" as const, value: params.type }]
          : []),
        ...(params.timeFrame != null
          ? [{ field: "timeFrame" as const, operator: "==" as const, value: params.timeFrame }]
          : []),
        ...(params.businessId != null && params.businessId.trim() !== ""
          ? [
              {
                field: "businessId" as const,
                operator: "==" as const,
                value: params.businessId.trim(),
              },
            ]
          : []),
        ...(params.branchId != null && params.branchId.trim() !== ""
          ? [
              {
                field: "branchId" as const,
                operator: "==" as const,
                value: params.branchId.trim(),
              },
            ]
          : []),
        ...(params.employeeId != null && params.employeeId.trim() !== ""
          ? [
              {
                field: "employeeId" as const,
                operator: "==" as const,
                value: params.employeeId.trim(),
              },
            ]
          : []),
        ...(params.date != null && params.date.trim() !== ""
          ? [{ field: "date" as const, operator: "==" as const, value: params.date.trim() }]
          : []),
        ...(params.month != null && params.month.trim() !== ""
          ? [
              {
                field: "month" as const,
                operator: "==" as const,
                value: params.month.trim(),
              },
            ]
          : []),
      ];

      const result = await FirestoreService.getAllPaginated<Metric>(
        COLLECTION_NAME,
        { page, pageSize },
        filters
      );

      return result as PaginatedResult<Metric>;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async applyAppointmentMetricDelta(
    input: ApplyAppointmentMetricDeltaInput
  ): Promise<void> {
    const businessId = input.businessId.trim();
    const branchId = input.branchId.trim();
    const employeeId = input.employeeId.trim();
    const date = input.date.trim();

    if (businessId === "" || branchId === "" || employeeId === "" || date === "") {
      throw CustomError.badRequest(
        "businessId, branchId, employeeId y date son requeridos para actualizar métricas"
      );
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      throw CustomError.badRequest("date debe tener formato YYYY-MM-DD");
    }

    const month = date.slice(0, 7);
    const deltas: MetricDeltas = {
      revenueDelta: this.normalizeDelta(input.revenueDelta),
      appointmentsDelta: this.normalizeDelta(input.appointmentsDelta),
      completedAppointmentsDelta: this.normalizeDelta(input.completedAppointmentsDelta),
      cancelledAppointmentsDelta: this.normalizeDelta(input.cancelledAppointmentsDelta),
    };

    if (this.isZeroDelta(deltas)) return;

    await Promise.all([
      this.applyDeltaToMetricDocument(
        { type: "BUSSINESS", businessId, date },
        deltas
      ),
      this.applyDeltaToMetricDocument(
        { type: "BUSSINESS", businessId, month },
        deltas
      ),
      this.applyDeltaToMetricDocument(
        { type: "BRANCH", branchId, date },
        deltas
      ),
      this.applyDeltaToMetricDocument(
        { type: "BRANCH", branchId, month },
        deltas
      ),
      this.applyDeltaToMetricDocument(
        { type: "EMPLOYEE", employeeId, date },
        deltas
      ),
      this.applyDeltaToMetricDocument(
        { type: "EMPLOYEE", employeeId, month },
        deltas
      ),
    ]);
  }

  private async applyDeltaToMetricDocument(
    identity: MetricIdentity,
    deltas: MetricDeltas
  ): Promise<void> {
    const timeFrame = this.resolveMetricTimeFrame(identity);

    const filters = [
      { field: "type" as const, operator: "==" as const, value: identity.type },
      ...(identity.businessId != null
        ? [
            {
              field: "businessId" as const,
              operator: "==" as const,
              value: identity.businessId,
            },
          ]
        : []),
      ...(identity.branchId != null
        ? [
            {
              field: "branchId" as const,
              operator: "==" as const,
              value: identity.branchId,
            },
          ]
        : []),
      ...(identity.employeeId != null
        ? [
            {
              field: "employeeId" as const,
              operator: "==" as const,
              value: identity.employeeId,
            },
          ]
        : []),
      ...(identity.date != null
        ? [{ field: "date" as const, operator: "==" as const, value: identity.date }]
        : []),
      ...(identity.month != null
        ? [{ field: "month" as const, operator: "==" as const, value: identity.month }]
        : []),
    ];

    const existingMetrics = await FirestoreService.getAll<Metric>(COLLECTION_NAME, filters);
    const existingMetric = existingMetrics[0] ?? null;

    if (existingMetric == null) {
      await FirestoreService.create(COLLECTION_NAME, {
        type: identity.type,
        timeFrame,
        ...(identity.businessId != null && { businessId: identity.businessId }),
        ...(identity.branchId != null && { branchId: identity.branchId }),
        ...(identity.employeeId != null && { employeeId: identity.employeeId }),
        ...(identity.date != null && { date: identity.date }),
        ...(identity.month != null && { month: identity.month }),
        revenue: this.toNonNegative(deltas.revenueDelta),
        appointments: this.toNonNegative(deltas.appointmentsDelta),
        completedAppointments: this.toNonNegative(deltas.completedAppointmentsDelta),
        cancelledAppointments: this.toNonNegative(deltas.cancelledAppointmentsDelta),
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });
      return;
    }

    const cleanupByType: Record<string, unknown> =
      identity.type === "BUSSINESS"
        ? {
            branchId: FieldValue.delete(),
            employeeId: FieldValue.delete(),
          }
        : identity.type === "BRANCH"
          ? {
              businessId: FieldValue.delete(),
              employeeId: FieldValue.delete(),
            }
          : {
              businessId: FieldValue.delete(),
              branchId: FieldValue.delete(),
            };

    await FirestoreService.update(COLLECTION_NAME, existingMetric.id, {
      ...cleanupByType,
      timeFrame,
      revenue: this.toNonNegative((existingMetric.revenue ?? 0) + deltas.revenueDelta),
      appointments: this.toNonNegative(
        (existingMetric.appointments ?? 0) + deltas.appointmentsDelta
      ),
      completedAppointments: this.toNonNegative(
        (existingMetric.completedAppointments ?? 0) + deltas.completedAppointmentsDelta
      ),
      cancelledAppointments: this.toNonNegative(
        (existingMetric.cancelledAppointments ?? 0) + deltas.cancelledAppointmentsDelta
      ),
      updatedAt: FirestoreDataBase.generateTimeStamp(),
    });
  }

  private resolveOptionalEntityId(input: GetMetricInsightsInput): string | undefined {
    if (input.entityType === "BUSSINESS") {
      const businessId = input.businessId?.trim() ?? "";
      return businessId === "" ? undefined : businessId;
    }

    if (input.entityType === "BRANCH") {
      const branchId = input.branchId?.trim() ?? "";
      return branchId === "" ? undefined : branchId;
    }

    const employeeId = input.employeeId?.trim() ?? "";
    return employeeId === "" ? undefined : employeeId;
  }

  private buildInsightQueryFilters(
    input: GetMetricInsightsInput,
    entityId?: string
  ): InsightFilterBuildResult {
    const hasTimeframe = input.timeframe != null;
    const timeframe: MetricTimeFrame = hasTimeframe ? input.timeframe! : "DAILY";

    const startDate = input.startDate?.trim();
    const endDate = input.endDate?.trim();
    const sameDate = input.sameDate === true;

    if (!hasTimeframe) {
      if (endDate != null && startDate == null) {
        throw CustomError.badRequest("No puedes enviar endDate sin startDate");
      }

      if (startDate == null) {
        throw CustomError.badRequest(
          "Debes enviar timeframe o startDate para consultar métricas"
        );
      }
    }

    if (startDate != null && endDate != null && endDate < startDate) {
      throw CustomError.badRequest("endDate no puede ser menor que startDate");
    }

    const entityField =
      input.entityType === "BUSSINESS"
        ? "businessId"
        : input.entityType === "BRANCH"
          ? "branchId"
          : "employeeId";

    const baseFilters: DbFilters[] = [
      { field: "type", operator: "==", value: input.entityType },
      { field: "timeFrame", operator: "==", value: timeframe },
      ...(entityId != null ? [{ field: entityField, operator: "==" as const, value: entityId }] : []),
    ];

    const filters: DbFilters[] = [...baseFilters];
    const period: InsightPeriod = { sameDate: false };

    if (!hasTimeframe && startDate != null) {
      if (sameDate) {
        filters.push({ field: "date", operator: "==", value: startDate });
        period.startDate = startDate;
        period.endDate = startDate;
        period.sameDate = true;
      } else if (endDate != null) {
        filters.push({ field: "date", operator: ">=", value: startDate });
        filters.push({ field: "date", operator: "<=", value: endDate });
        period.startDate = startDate;
        period.endDate = endDate;
      } else {
        filters.push({ field: "date", operator: ">=", value: startDate });
        period.startDate = startDate;
      }
    }

    return {
      timeframe,
      period,
      baseFilters,
      filters,
    };
  }

  private computeTotals(metrics: Metric[]): MetricTotals {
    return metrics.reduce<MetricTotals>(
      (acc, metric) => {
        acc.revenue += Number.isFinite(metric.revenue) ? metric.revenue : 0;
        acc.appointments += Number.isFinite(metric.appointments) ? metric.appointments : 0;
        acc.completedAppointments += Number.isFinite(metric.completedAppointments)
          ? metric.completedAppointments
          : 0;
        acc.cancelledAppointments += Number.isFinite(metric.cancelledAppointments)
          ? metric.cancelledAppointments
          : 0;
        return acc;
      },
      {
        revenue: 0,
        appointments: 0,
        completedAppointments: 0,
        cancelledAppointments: 0,
      }
    );
  }

  private computeEmployeeProductivity(metrics: Metric[]): EmployeeProductivityItem[] {
    const revenueByEmployee = new Map<string, number>();

    for (const metric of metrics) {
      const employeeId = metric.employeeId?.trim() ?? "";
      if (employeeId === "") continue;

      const previous = revenueByEmployee.get(employeeId) ?? 0;
      revenueByEmployee.set(
        employeeId,
        previous + (Number.isFinite(metric.revenue) ? metric.revenue : 0)
      );
    }

    return Array.from(revenueByEmployee.entries())
      .map(([employeeId, revenue]) => ({ employeeId, revenue }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  private async calculateBusinessGrowthByPreviousPeriod(params: {
    timeframe: MetricTimeFrame;
    period: InsightPeriod;
    currentMetrics: Metric[];
    currentRevenue: number;
    baseFilters: DbFilters[];
  }): Promise<number | null> {
    if (params.period.startDate == null) {
      return this.calculateGrowthUsingLastTwoBuckets(params.currentMetrics, params.timeframe);
    }

    const currentStart = params.period.startDate;
    const currentEnd =
      params.period.endDate ??
      this.getMaxMetricDate(params.currentMetrics) ??
      params.period.startDate;

    if (currentEnd < currentStart) {
      return null;
    }

    const spanDays = this.diffDays(currentStart, currentEnd) + 1;
    if (!Number.isFinite(spanDays) || spanDays <= 0) {
      return null;
    }

    const previousEnd = this.addDays(currentStart, -1);
    const previousStart = this.addDays(currentStart, -spanDays);

    const previousFilters = this.buildDateRangeFilters(
      params.baseFilters,
      previousStart,
      previousEnd
    );

    const previousMetrics = await FirestoreService.getAll<Metric>(
      COLLECTION_NAME,
      previousFilters
    );
    const previousRevenue = this.computeTotals(previousMetrics).revenue;

    if (previousRevenue <= 0) return null;

    return (params.currentRevenue - previousRevenue) / previousRevenue;
  }

  private calculateGrowthUsingLastTwoBuckets(
    metrics: Metric[],
    timeframe: MetricTimeFrame
  ): number | null {
    const revenueByBucket = new Map<string, number>();

    for (const metric of metrics) {
      const bucket =
        timeframe === "DAILY"
          ? metric.date?.trim() ?? ""
          : metric.month?.trim() ?? "";
      if (bucket === "") continue;

      const previous = revenueByBucket.get(bucket) ?? 0;
      revenueByBucket.set(bucket, previous + (Number.isFinite(metric.revenue) ? metric.revenue : 0));
    }

    if (revenueByBucket.size < 2) return null;

    const ordered = Array.from(revenueByBucket.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const previousRevenue = ordered[ordered.length - 2]?.[1] ?? 0;
    const currentRevenue = ordered[ordered.length - 1]?.[1] ?? 0;

    if (previousRevenue <= 0) return null;
    return (currentRevenue - previousRevenue) / previousRevenue;
  }

  private getMaxMetricDate(metrics: Metric[]): string | undefined {
    const dates = metrics
      .map((metric) => metric.date?.trim())
      .filter((date): date is string => date != null && date !== "");

    if (dates.length === 0) return undefined;
    return dates.sort((a, b) => a.localeCompare(b))[dates.length - 1];
  }

  private buildDateRangeFilters(
    baseFilters: DbFilters[],
    startDate: string,
    endDate: string
  ): DbFilters[] {
    return [
      ...baseFilters,
      { field: "date", operator: ">=", value: startDate },
      { field: "date", operator: "<=", value: endDate },
    ];
  }

  private addDays(date: string, delta: number): string {
    const parsed = this.parseDateUTC(date);
    parsed.setUTCDate(parsed.getUTCDate() + delta);
    return this.formatDateUTC(parsed);
  }

  private diffDays(startDate: string, endDate: string): number {
    const start = this.parseDateUTC(startDate).getTime();
    const end = this.parseDateUTC(endDate).getTime();
    return Math.floor((end - start) / 86_400_000);
  }

  private parseDateUTC(date: string): Date {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw CustomError.badRequest(`Fecha inválida: ${date}`);
    }
    return parsed;
  }

  private formatDateUTC(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private resolveMetricTimeFrame(identity: MetricIdentity): MetricTimeFrame {
    if (identity.date != null) return "DAILY";
    if (identity.month != null) return "MONTHLY";

    throw CustomError.internalServerError(
      "No se pudo determinar timeFrame de la métrica: falta date o month"
    );
  }

  private normalizeDelta(value: number | undefined): number {
    if (value == null || !Number.isFinite(value)) return 0;
    return value;
  }

  private isZeroDelta(deltas: MetricDeltas): boolean {
    return (
      deltas.revenueDelta === 0 &&
      deltas.appointmentsDelta === 0 &&
      deltas.completedAppointmentsDelta === 0 &&
      deltas.cancelledAppointmentsDelta === 0
    );
  }

  private toNonNegative(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value;
  }
}
