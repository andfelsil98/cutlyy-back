import { CustomError } from "../../../domain/errors/custom-error";
import { normalizeSpaces } from "../../../domain/utils/string.utils";
import type { AppointmentStatus } from "../../../domain/interfaces/appointment.interface";

export interface UpdateAppointmentDto {
  date: string;
  startTime: string;
  endTime: string;
  serviceId: string;
  employeeId: string;
  status?: Exclude<AppointmentStatus, "DELETED">;
}

function parseIsoDateOrThrow(
  rawValue: string,
  fieldPath: string
): string {
  const value = normalizeSpaces(rawValue);
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

  if (!isoDateRegex.test(value)) {
    throw CustomError.badRequest(
      `${fieldPath} debe tener formato de fecha ISO 8601 (ej: 2026-03-10)`
    );
  }

  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(millis)) {
    throw CustomError.badRequest(`${fieldPath} debe ser una fecha válida`);
  }

  return value;
}

function parseTimeOrThrow(
  rawValue: string,
  fieldPath: string
): { value: string; millis: number } {
  const value = normalizeSpaces(rawValue);
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

  const match = value.match(timeRegex);
  if (!match) {
    throw CustomError.badRequest(
      `${fieldPath} debe tener formato de hora HH:mm (ej: 09:00)`
    );
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const millis = (hours * 60 + minutes) * 60 * 1000;

  return { value, millis };
}

function validateStatus(rawStatus: unknown): Exclude<AppointmentStatus, "DELETED"> {
  if (typeof rawStatus !== "string" || rawStatus.trim() === "") {
    throw CustomError.badRequest("status debe ser un texto no vacío cuando se proporcione");
  }

  const normalizedStatus = normalizeSpaces(rawStatus).toUpperCase();
  if (
    normalizedStatus !== "CREATED" &&
    normalizedStatus !== "CANCELLED" &&
    normalizedStatus !== "FINISHED"
  ) {
    throw CustomError.badRequest(
      "El estado debe ser creado, cancelado o finalizado"
    );
  }

  return normalizedStatus as Exclude<AppointmentStatus, "DELETED">;
}

export function validateUpdateAppointmentDto(body: unknown): UpdateAppointmentDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const parsedBody = body as Record<string, unknown>;

  if (parsedBody.businessId !== undefined) {
    throw CustomError.badRequest(
      "businessId no es editable y no debe enviarse en la actualización"
    );
  }
  if (parsedBody.branchId !== undefined) {
    throw CustomError.badRequest(
      "branchId no es editable y no debe enviarse en la actualización"
    );
  }
  if (parsedBody.clientId !== undefined) {
    throw CustomError.badRequest(
      "clientId no es editable y no debe enviarse en la actualización"
    );
  }
  if (parsedBody.bookingId !== undefined) {
    throw CustomError.badRequest(
      "bookingId no es editable y no debe enviarse en la actualización"
    );
  }
  if (parsedBody.services !== undefined) {
    throw CustomError.badRequest(
      "services no es editable y no debe enviarse en la actualización"
    );
  }

  const dateRaw = parsedBody.date;
  if (typeof dateRaw !== "string" || dateRaw.trim() === "") {
    throw CustomError.badRequest(
      "date es requerido y debe ser un texto no vacío"
    );
  }
  const date = parseIsoDateOrThrow(dateRaw, "date");

  const startTimeRaw = parsedBody.startTime;
  if (typeof startTimeRaw !== "string" || startTimeRaw.trim() === "") {
    throw CustomError.badRequest(
      "startTime es requerido y debe ser un texto no vacío"
    );
  }
  const startTime = parseTimeOrThrow(startTimeRaw, "startTime");

  const endTimeRaw = parsedBody.endTime;
  if (typeof endTimeRaw !== "string" || endTimeRaw.trim() === "") {
    throw CustomError.badRequest(
      "endTime es requerido y debe ser un texto no vacío"
    );
  }
  const endTime = parseTimeOrThrow(endTimeRaw, "endTime");

  if (endTime.millis <= startTime.millis) {
    throw CustomError.badRequest("endTime debe ser mayor que startTime");
  }

  const serviceIdRaw = parsedBody.serviceId;
  if (typeof serviceIdRaw !== "string" || serviceIdRaw.trim() === "") {
    throw CustomError.badRequest(
      "serviceId es requerido y debe ser un texto no vacío"
    );
  }

  const employeeIdRaw = parsedBody.employeeId;
  if (typeof employeeIdRaw !== "string" || employeeIdRaw.trim() === "") {
    throw CustomError.badRequest(
      "employeeId es requerido y debe ser un texto no vacío"
    );
  }

  const status =
    parsedBody.status !== undefined
      ? validateStatus(parsedBody.status)
      : undefined;

  return {
    date,
    startTime: startTime.value,
    endTime: endTime.value,
    serviceId: normalizeSpaces(serviceIdRaw),
    employeeId: normalizeSpaces(employeeIdRaw),
    ...(status !== undefined && { status }),
  };
}

export function validateAppointmentIdParam(id: unknown): string {
  if (id == null || typeof id !== "string" || id.trim() === "") {
    throw CustomError.badRequest("El parámetro id es requerido y debe ser un texto no vacío");
  }
  return id.trim();
}
