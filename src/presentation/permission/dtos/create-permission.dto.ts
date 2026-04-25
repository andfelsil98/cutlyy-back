import { CustomError } from "../../../domain/errors/custom-error";
import {
  isAccessEntityType,
  type AccessEntityType,
} from "../../../domain/constants/access-control.constants";
import {
  formatName,
  normalizeSpaces,
} from "../../../domain/utils/string.utils";

export interface CreatePermissionDto {
  name: string;
  value: string;
  type: AccessEntityType;
  description?: string;
  moduleId: string;
}

export function validateCreatePermissionDto(body: unknown): CreatePermissionDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const b = body as Record<string, unknown>;

  const nameRaw = b.name;
  if (typeof nameRaw !== "string" || nameRaw.trim() === "") {
    throw CustomError.badRequest("name es requerido y debe ser un texto no vacío");
  }
  const name = formatName(nameRaw);

  const valueRaw = b.value;
  if (typeof valueRaw !== "string" || valueRaw.trim() === "") {
    throw CustomError.badRequest("value es requerido y debe ser un texto no vacío");
  }
  const value = normalizeSpaces(valueRaw);

  const typeRaw = b.type;
  if (!isAccessEntityType(typeRaw)) {
    throw CustomError.badRequest(
      "El tipo debe ser de negocio, global o híbrido"
    );
  }
  const type = typeRaw;

  const descriptionRaw = b.description;
  let description: string | undefined;
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw !== "string") {
      throw CustomError.badRequest(
        "description debe ser un texto cuando se proporcione"
      );
    }
    const normalized = normalizeSpaces(descriptionRaw);
    if (normalized !== "") {
      description = normalized;
    }
  }

  const moduleIdRaw = b.moduleId;
  if (typeof moduleIdRaw !== "string" || moduleIdRaw.trim() === "") {
    throw CustomError.badRequest(
      "moduleId es requerido y debe ser un texto no vacío"
    );
  }
  const moduleId = moduleIdRaw.trim();

  return {
    name,
    value,
    type,
    ...(description !== undefined && { description }),
    moduleId,
  };
}
