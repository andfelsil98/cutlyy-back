import { CustomError } from "../../../domain/errors/custom-error";
import {
  isAccessEntityType,
  type AccessEntityType,
} from "../../../domain/constants/access-control.constants";
import {
  formatName,
  normalizeSpaces,
} from "../../../domain/utils/string.utils";

export interface CreateModuleDto {
  name: string;
  value: string;
  type: AccessEntityType;
  description?: string;
}

export function validateCreateModuleDto(body: unknown): CreateModuleDto {
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
    const normalizedDescription = normalizeSpaces(descriptionRaw);
    if (normalizedDescription !== "") {
      description = normalizedDescription;
    }
  }

  return {
    name,
    value,
    type,
    ...(description !== undefined && { description }),
  };
}
