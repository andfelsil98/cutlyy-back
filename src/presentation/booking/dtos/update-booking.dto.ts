import { CustomError } from "../../../domain/errors/custom-error";
import type {
  BookingPaymentMethod,
  BookingStatus,
} from "../../../domain/interfaces/booking.interface";
import { normalizeSpaces } from "../../../domain/utils/string.utils";

export type BookingOperationType = "add" | "update" | "cancel";

export interface AddBookingAppointmentOperationDto {
  op: "add";
  date: string;
  startTime: string;
  endTime: string;
  serviceId: string;
  employeeId: string;
}

export interface UpdateBookingAppointmentOperationDto {
  op: "update";
  appointmentId: string;
  date: string;
  startTime: string;
  endTime: string;
  serviceId: string;
  employeeId: string;
}

export interface CancelBookingAppointmentOperationDto {
  op: "cancel";
  appointmentId: string;
}

export type BookingAppointmentOperationDto =
  | AddBookingAppointmentOperationDto
  | UpdateBookingAppointmentOperationDto
  | CancelBookingAppointmentOperationDto;

export type PublicManageBookingOperationDto =
  | UpdateBookingAppointmentOperationDto
  | CancelBookingAppointmentOperationDto;

export interface UpdateBookingDto {
  branchId?: string;
  clientId?: string;
  clientDocumentTypeId?: string;
  clientDocumentTypeName?: string;
  clientName?: string;
  clientPhone?: string;
  clientEmail?: string;
  paymentMethod?: BookingPaymentMethod;
  paidAmount?: number;
  status?: BookingStatus;
  operations?: BookingAppointmentOperationDto[];
}

export interface PublicManageBookingDto {
  status?: "CANCELLED";
  operations?: PublicManageBookingOperationDto[];
}

const PAYMENT_METHODS: BookingPaymentMethod[] = [
  "CASH",
  "NEQUI",
  "DAVIPLATA",
  "QR",
  "CARD",
  "TRANSFER",
];

export function validateBookingIdParam(id: unknown): string {
  if (id == null || typeof id !== "string" || id.trim() === "") {
    throw CustomError.badRequest("El parámetro id es requerido y debe ser un texto no vacío");
  }
  return id.trim();
}

function parseIsoDateOrThrow(rawValue: string, fieldPath: string): string {
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

function validateOptionalStringField(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw CustomError.badRequest(
      `${field} debe ser un texto no vacío cuando se proporcione`
    );
  }
  return normalizeSpaces(value);
}

function validateOperation(
  operation: unknown,
  index: number
): BookingAppointmentOperationDto {
  if (operation == null || typeof operation !== "object" || Array.isArray(operation)) {
    throw CustomError.badRequest(
      `operations[${index}] debe ser un objeto`
    );
  }

  const opData = operation as Record<string, unknown>;
  const opRaw = opData.op;
  if (opRaw !== "add" && opRaw !== "update" && opRaw !== "cancel") {
    throw CustomError.badRequest(
      `operations[${index}].op debe ser add, update o cancel`
    );
  }

  if (opRaw === "cancel") {
    const appointmentIdRaw = opData.appointmentId;
    if (typeof appointmentIdRaw !== "string" || appointmentIdRaw.trim() === "") {
      throw CustomError.badRequest(
        `operations[${index}].appointmentId es requerido para op=cancel`
      );
    }

    return {
      op: "cancel",
      appointmentId: appointmentIdRaw.trim(),
    };
  }

  const dateRaw = opData.date;
  if (typeof dateRaw !== "string" || dateRaw.trim() === "") {
    throw CustomError.badRequest(`operations[${index}].date es requerido`);
  }
  const date = parseIsoDateOrThrow(dateRaw, `operations[${index}].date`);

  const startTimeRaw = opData.startTime;
  if (typeof startTimeRaw !== "string" || startTimeRaw.trim() === "") {
    throw CustomError.badRequest(`operations[${index}].startTime es requerido`);
  }
  const startTime = parseTimeOrThrow(startTimeRaw, `operations[${index}].startTime`);

  const endTimeRaw = opData.endTime;
  if (typeof endTimeRaw !== "string" || endTimeRaw.trim() === "") {
    throw CustomError.badRequest(`operations[${index}].endTime es requerido`);
  }
  const endTime = parseTimeOrThrow(endTimeRaw, `operations[${index}].endTime`);

  if (endTime.millis <= startTime.millis) {
    throw CustomError.badRequest(
      `operations[${index}].endTime debe ser mayor que startTime`
    );
  }

  const serviceIdRaw = opData.serviceId;
  if (typeof serviceIdRaw !== "string" || serviceIdRaw.trim() === "") {
    throw CustomError.badRequest(`operations[${index}].serviceId es requerido`);
  }

  const employeeIdRaw = opData.employeeId;
  if (typeof employeeIdRaw !== "string" || employeeIdRaw.trim() === "") {
    throw CustomError.badRequest(`operations[${index}].employeeId es requerido`);
  }

  if (opRaw === "update") {
    const appointmentIdRaw = opData.appointmentId;
    if (typeof appointmentIdRaw !== "string" || appointmentIdRaw.trim() === "") {
      throw CustomError.badRequest(
        `operations[${index}].appointmentId es requerido para op=update`
      );
    }

    return {
      op: "update",
      appointmentId: appointmentIdRaw.trim(),
      date,
      startTime: startTime.value,
      endTime: endTime.value,
      serviceId: serviceIdRaw.trim(),
      employeeId: employeeIdRaw.trim(),
    };
  }

  return {
    op: "add",
    date,
    startTime: startTime.value,
    endTime: endTime.value,
    serviceId: serviceIdRaw.trim(),
    employeeId: employeeIdRaw.trim(),
  };
}

export function validateUpdateBookingDto(body: unknown): UpdateBookingDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const parsedBody = body as Record<string, unknown>;

  const branchId = validateOptionalStringField(parsedBody.branchId, "branchId");
  const clientId = validateOptionalStringField(parsedBody.clientId, "clientId");
  const clientDocumentTypeId = validateOptionalStringField(
    parsedBody.clientDocumentTypeId,
    "clientDocumentTypeId"
  );
  const clientDocumentTypeName = validateOptionalStringField(
    parsedBody.clientDocumentTypeName,
    "clientDocumentTypeName"
  );
  const clientName = validateOptionalStringField(parsedBody.clientName, "clientName");
  const clientPhone = validateOptionalStringField(parsedBody.clientPhone, "clientPhone");
  const clientEmail = validateOptionalStringField(parsedBody.clientEmail, "clientEmail");

  const paymentMethodRaw = parsedBody.paymentMethod;
  let paymentMethod: BookingPaymentMethod | undefined;
  if (paymentMethodRaw !== undefined) {
    if (typeof paymentMethodRaw !== "string" || paymentMethodRaw.trim() === "") {
      throw CustomError.badRequest(
        "paymentMethod debe ser un texto no vacío cuando se proporcione"
      );
    }
    const normalizedPaymentMethod = normalizeSpaces(paymentMethodRaw).toUpperCase() as BookingPaymentMethod;
    if (!PAYMENT_METHODS.includes(normalizedPaymentMethod)) {
      throw CustomError.badRequest(
        `paymentMethod debe ser uno de: ${PAYMENT_METHODS.join(", ")}`
      );
    }
    paymentMethod = normalizedPaymentMethod;
  }

  const paidAmountRaw = parsedBody.paidAmount;
  let paidAmount: number | undefined;
  if (paidAmountRaw !== undefined) {
    if (typeof paidAmountRaw !== "number" || Number.isNaN(paidAmountRaw) || paidAmountRaw < 0) {
      throw CustomError.badRequest(
        "paidAmount debe ser un número mayor o igual a 0 cuando se proporcione"
      );
    }
    paidAmount = paidAmountRaw;
  }

  if (
    clientId === undefined &&
    (clientDocumentTypeId !== undefined ||
      clientDocumentTypeName !== undefined ||
      clientName !== undefined ||
      clientPhone !== undefined ||
      clientEmail !== undefined)
  ) {
    throw CustomError.badRequest(
      "Si envías datos del cliente, también debes enviar clientId"
    );
  }

  const statusRaw = parsedBody.status;
  let status: BookingStatus | undefined;
  if (statusRaw !== undefined) {
    if (typeof statusRaw !== "string" || statusRaw.trim() === "") {
      throw CustomError.badRequest(
        "status debe ser un texto no vacío cuando se proporcione"
      );
    }

    const normalizedStatus = normalizeSpaces(statusRaw).toUpperCase();
    if (
      normalizedStatus !== "CREATED" &&
      normalizedStatus !== "CANCELLED" &&
      normalizedStatus !== "FINISHED" &&
      normalizedStatus !== "DELETED"
    ) {
      throw CustomError.badRequest(
        "El estado debe ser creado, cancelado, finalizado o eliminado"
      );
    }
    status = normalizedStatus as BookingStatus;
  }

  const operationsRaw = parsedBody.operations;
  let operations: BookingAppointmentOperationDto[] | undefined;
  if (operationsRaw !== undefined) {
    if (!Array.isArray(operationsRaw)) {
      throw CustomError.badRequest("operations debe ser un arreglo");
    }
    if (operationsRaw.length === 0) {
      throw CustomError.badRequest(
        "operations debe contener al menos una operación"
      );
    }
    operations = operationsRaw.map((operation, index) =>
      validateOperation(operation, index)
    );
  }

  if (
    branchId === undefined &&
    clientId === undefined &&
    paymentMethod === undefined &&
    paidAmount === undefined &&
    status === undefined &&
    operations === undefined
  ) {
    throw CustomError.badRequest(
      "Debes enviar al menos un campo para actualizar el booking"
    );
  }

  return {
    ...(branchId !== undefined && { branchId }),
    ...(clientId !== undefined && { clientId }),
    ...(clientDocumentTypeId !== undefined && { clientDocumentTypeId }),
    ...(clientDocumentTypeName !== undefined && { clientDocumentTypeName }),
    ...(clientName !== undefined && { clientName }),
    ...(clientPhone !== undefined && { clientPhone }),
    ...(clientEmail !== undefined && { clientEmail }),
    ...(paymentMethod !== undefined && { paymentMethod }),
    ...(paidAmount !== undefined && { paidAmount }),
    ...(status !== undefined && { status }),
    ...(operations !== undefined && { operations }),
  };
}

export function validatePublicManageBookingDto(
  body: unknown
): PublicManageBookingDto {
  const dto = validateUpdateBookingDto(body);

  const hasRestrictedAdministrativeFields =
    dto.branchId !== undefined ||
    dto.clientId !== undefined ||
    dto.clientDocumentTypeId !== undefined ||
    dto.clientDocumentTypeName !== undefined ||
    dto.clientName !== undefined ||
    dto.clientPhone !== undefined ||
    dto.clientEmail !== undefined ||
    dto.paymentMethod !== undefined ||
    dto.paidAmount !== undefined;

  if (hasRestrictedAdministrativeFields) {
    throw CustomError.badRequest(
      "Desde la gestión pública solo puedes cancelar el agendamiento o editar/cancelar citas existentes"
    );
  }

  if (dto.status !== undefined && dto.status !== "CANCELLED") {
    throw CustomError.badRequest(
      "Desde la gestión pública solo puedes cancelar el agendamiento completo"
    );
  }

  const hasAddOperations = (dto.operations ?? []).some(
    (operation) => operation.op === "add"
  );
  if (hasAddOperations) {
    throw CustomError.badRequest(
      "Desde la gestión pública no se pueden agregar nuevas citas al agendamiento"
    );
  }

  if (dto.status !== undefined && dto.operations !== undefined) {
    throw CustomError.badRequest(
      "Debes elegir entre cancelar el agendamiento completo o editar/cancelar sus citas existentes"
    );
  }

  return {
    ...(dto.status !== undefined && { status: dto.status }),
    ...(dto.operations !== undefined && {
      operations: dto.operations.filter(
        (operation): operation is PublicManageBookingOperationDto =>
          operation.op === "update" || operation.op === "cancel"
      ),
    }),
  };
}
