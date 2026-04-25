import {
  METRIC_TYPE_QUERY_ALIASES,
  type MetricCalculationType,
} from "../../../config/metric-types.config";
import { CustomError } from "../../../domain/errors/custom-error";
import type {
  MetricTimeFrame,
  MetricType,
} from "../../../domain/interfaces/metric.interface";

export function parseEntityType(value: unknown): MetricType {
  if (typeof value !== "string") {
    throw CustomError.badRequest("El tipo de entidad es requerido y debe ser negocio, sede o empleado");
  }

  const normalized = value.trim().toUpperCase();
  if (normalized !== "BUSSINESS" && normalized !== "BRANCH" && normalized !== "EMPLOYEE") {
    throw CustomError.badRequest("El tipo de entidad debe ser negocio, sede o empleado");
  }

  return normalized as MetricType;
}

export function parseMetricTypes(value: unknown): MetricCalculationType[] {
  if (value == null) {
    throw CustomError.badRequest("metricTypes es requerido");
  }

  const rawValues = Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .flatMap((item) => item.split(","))
    : typeof value === "string"
      ? value.split(",")
      : [];

  const normalizedTypes = rawValues
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const normalizedKey = item
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/\s+/g, "_")
        .toLowerCase();

      const fromAlias = METRIC_TYPE_QUERY_ALIASES[normalizedKey];
      if (fromAlias != null) return fromAlias;

      const upper = item.toUpperCase();
      const direct = Object.values(METRIC_TYPE_QUERY_ALIASES).find(
        (metricType) => metricType === upper
      );
      if (direct != null) return direct;

      throw CustomError.badRequest(
        "metricTypes contiene un valor inválido. Usa métricas de ingresos, cantidad de citas, ticket promedio, cancelación, finalización, productividad de empleados o crecimiento del negocio"
      );
    });

  if (normalizedTypes.length === 0) {
    throw CustomError.badRequest("metricTypes debe incluir al menos una métrica");
  }

  return Array.from(new Set(normalizedTypes));
}

export function parseMetricTimeFrame(value: unknown): MetricTimeFrame | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw CustomError.badRequest("La ventana de tiempo debe ser diaria o mensual");
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "") return undefined;
  if (normalized !== "DAILY" && normalized !== "MONTHLY") {
    throw CustomError.badRequest("La ventana de tiempo debe ser diaria o mensual");
  }

  return normalized as MetricTimeFrame;
}

export function parseDateFilter(value: unknown, fieldName: "startDate" | "endDate"): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw CustomError.badRequest(`${fieldName} debe tener formato YYYY-MM-DD`);
  }

  const normalized = value.trim();
  if (normalized === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw CustomError.badRequest(`${fieldName} debe tener formato YYYY-MM-DD`);
  }

  return normalized;
}

export function parseSameDate(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "boolean") return value;

  if (typeof value !== "string") {
    throw CustomError.badRequest("sameDate debe ser true o false");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  throw CustomError.badRequest("sameDate debe ser true o false");
}
