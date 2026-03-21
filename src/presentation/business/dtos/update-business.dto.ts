import { CustomError } from "../../../domain/errors/custom-error";
import { validateConsecutivePrefix } from "../../../domain/utils/booking-consecutive.utils";
import {
  normalizeSpaces,
  removeAccents,
  slugFromName,
} from "../../../domain/utils/string.utils";
import type { BusinessType } from "./create-business.dto";
import { BUSINESS_TYPES, isBusinessType } from "./create-business.dto";
import type { CreateServiceItemDto } from "../../service/dtos/create-service.dto";
import { validateCreateServiceItemDto } from "../../service/dtos/create-service.dto";
import type { CreateBranchItemDto } from "../../branch/dtos/create-branch.dto";
import { validateCreateBranchItemDto } from "../../branch/dtos/create-branch.dto";

export interface UpdateBusinessDto {
  name?: string;
  type?: BusinessType;
  consecutivePrefix?: string;
  logoUrl?: string;
  /** Generado si se envía name. */
  slug?: string;
  services?: CreateServiceItemDto[];
  branches?: CreateBranchItemDto[];
}

export function validateUpdateBusinessDto(body: unknown): UpdateBusinessDto {
  if (body == null || typeof body !== "object") {
    throw CustomError.badRequest("El body debe ser un objeto");
  }
  const b = body as Record<string, unknown>;
  const result: UpdateBusinessDto = {};

  const nameRaw = b.name;
  if (nameRaw !== undefined) {
    if (typeof nameRaw !== "string") {
      throw CustomError.badRequest("name debe ser un texto cuando se proporcione");
    }
    const nameNormalized = normalizeSpaces(nameRaw);
    if (nameNormalized === "") {
      throw CustomError.badRequest("name no puede estar vacío");
    }
    const sanitizedName = normalizeSpaces(
      removeAccents(nameNormalized).replace(/[^a-zA-Z0-9\s]/g, " ")
    );
    if (sanitizedName === "") {
      throw CustomError.badRequest(
        "name debe tener al menos una letra o número luego de limpiar caracteres especiales"
      );
    }
    result.name = sanitizedName.toUpperCase();
    result.slug = slugFromName(result.name);
  }

  const type = b.type;
  if (type !== undefined) {
    if (!isBusinessType(type)) {
      throw CustomError.badRequest(
        `type debe ser uno de: ${BUSINESS_TYPES.join(", ")}`
      );
    }
    result.type = type;
  }

  if (b.consecutivePrefix !== undefined) {
    result.consecutivePrefix = validateConsecutivePrefix(
      b.consecutivePrefix,
      "consecutivePrefix"
    );
  }

  const logoUrlRaw = b.logoUrl;
  if (logoUrlRaw !== undefined) {
    if (typeof logoUrlRaw !== "string") {
      throw CustomError.badRequest("logoUrl debe ser un texto cuando se proporcione");
    }
    result.logoUrl = normalizeSpaces(String(logoUrlRaw));
  }

  const servicesRaw = b.services;
  if (servicesRaw !== undefined) {
    if (!Array.isArray(servicesRaw)) {
      throw CustomError.badRequest("services debe ser un arreglo cuando se proporcione");
    }
    if (servicesRaw.length === 0) {
      throw CustomError.badRequest("services debe tener al menos un servicio cuando se proporcione");
    }
    result.services = servicesRaw.map((item, index) => {
      try {
        return validateCreateServiceItemDto(item);
      } catch (error) {
        const message = error instanceof CustomError ? error.message : String(error);
        throw CustomError.badRequest(`Servicio en el índice ${index}: ${message}`);
      }
    });
  }

  const branchesRaw = b.branches;
  if (branchesRaw !== undefined) {
    if (!Array.isArray(branchesRaw)) {
      throw CustomError.badRequest("branches debe ser un arreglo cuando se proporcione");
    }
    if (branchesRaw.length === 0) {
      throw CustomError.badRequest("branches debe tener al menos una sede cuando se proporcione");
    }
    result.branches = branchesRaw.map((item, index) => {
      try {
        return validateCreateBranchItemDto(item);
      } catch (error) {
        const message = error instanceof CustomError ? error.message : String(error);
        throw CustomError.badRequest(`Sede en el índice ${index}: ${message}`);
      }
    });
  }

  if (Object.keys(result).length === 0) {
    throw CustomError.badRequest(
      "Se debe proporcionar al menos un campo (name, type, consecutivePrefix, logoUrl, services, branches)"
    );
  }

  return result;
}
