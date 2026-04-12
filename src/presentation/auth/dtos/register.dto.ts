import { CustomError } from "../../../domain/errors/custom-error";
import { normalizeSpaces, removeAccents } from "../../../domain/utils/string.utils";

/** Tipos de documento: id -> nombre. */
export const DOCUMENT_TYPES: Record<string, string> = {
  CC: "Cédula de ciudadanía",
  CE: "Cédula de extranjería",
  TI: "Tarjeta de identidad",
} as const;

export const DOCUMENT_TYPE_IDS = Object.keys(DOCUMENT_TYPES) as [string, ...string[]];

function isDocumentTypeId(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_TYPE_IDS.includes(value);
}

export interface RegisterDto {
  businessName?: string;
  phone: string;
  name: string;
  email: string;
  password: string;
  document: string;
  documentTypeName: string;
  documentTypeId: string;
}

export function validateRegisterDto(body: unknown): RegisterDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }
  const b = body as Record<string, unknown>;

  const businessNameRaw = b.businessName;
  let businessName: string | undefined;
  if (businessNameRaw !== undefined) {
    if (typeof businessNameRaw !== "string") {
      throw CustomError.badRequest(
        "businessName debe ser un texto cuando se proporcione"
      );
    }
    const normalizedBusinessName = normalizeSpaces(businessNameRaw);
    if (normalizedBusinessName !== "") {
      businessName = normalizedBusinessName;
    }
  }

  const phoneRaw = b.phone;
  if (typeof phoneRaw !== "string" || phoneRaw.trim() === "") {
    throw CustomError.badRequest("phone es requerido y debe ser un texto no vacío");
  }
  const phone = normalizeSpaces(phoneRaw);

  const nameRaw = b.name;
  if (typeof nameRaw !== "string" || nameRaw.trim() === "") {
    throw CustomError.badRequest("name es requerido y debe ser un texto no vacío");
  }
  const name = normalizeSpaces(nameRaw);

  const emailRaw = b.email;
  if (typeof emailRaw !== "string" || emailRaw.trim() === "") {
    throw CustomError.badRequest("email es requerido y debe ser un texto no vacío");
  }
  const email = normalizeSpaces(emailRaw);

  const passwordRaw = b.password;
  if (typeof passwordRaw !== "string" || passwordRaw.trim() === "") {
    throw CustomError.badRequest("password es requerido y debe ser un texto no vacío");
  }
  if (passwordRaw.length < 6) {
    throw CustomError.badRequest("password debe tener al menos 6 caracteres");
  }
  const password = passwordRaw;

  const documentRaw = b.document;
  if (typeof documentRaw !== "string" || documentRaw.trim() === "") {
    throw CustomError.badRequest("document es requerido y debe ser un texto no vacío");
  }
  const document = normalizeSpaces(documentRaw);

  const documentTypeIdRaw = b.documentTypeId;
  if (!isDocumentTypeId(documentTypeIdRaw)) {
    throw CustomError.badRequest(
      `documentTypeId debe ser uno de: ${DOCUMENT_TYPE_IDS.join(", ")}`
    );
  }
  const documentTypeId = documentTypeIdRaw.trim();

  const documentTypeNameRaw = b.documentTypeName;
  const expectedName = DOCUMENT_TYPES[documentTypeId];
  if (typeof documentTypeNameRaw !== "string" || documentTypeNameRaw.trim() === "") {
    throw CustomError.badRequest("documentTypeName es requerido y debe ser un texto no vacío");
  }
  const documentTypeName = normalizeSpaces(documentTypeNameRaw);
  const normalizedInput = removeAccents(documentTypeName).toLowerCase();
  const normalizedExpected = removeAccents(expectedName ?? "").toLowerCase();
  if (normalizedInput !== normalizedExpected) {
    throw CustomError.badRequest(
      `documentTypeName no coincide con documentTypeId ${documentTypeId}. Esperado: ${expectedName}`
    );
  }

  return {
    ...(businessName !== undefined && { businessName }),
    phone,
    name,
    email,
    password,
    document,
    documentTypeName,
    documentTypeId,
  };
}
