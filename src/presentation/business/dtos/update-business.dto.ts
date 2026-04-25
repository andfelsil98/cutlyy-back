import { CustomError } from "../../../domain/errors/custom-error";
import { validateConsecutivePrefix } from "../../../domain/utils/booking-consecutive.utils";
import { validateAndNormalizeStartPeriods } from "../../../domain/utils/usage-period.utils";
import { normalizeSpaces } from "../../../domain/utils/string.utils";
import type { BusinessType } from "./create-business.dto";
import { isBusinessType } from "./create-business.dto";
import type { CreateServiceItemDto } from "../../service/dtos/create-service.dto";
import { validateCreateServiceItemDto } from "../../service/dtos/create-service.dto";
import type { CreateBranchItemDto } from "../../branch/dtos/create-branch.dto";
import { validateCreateBranchItemDto } from "../../branch/dtos/create-branch.dto";

export interface UpdateBusinessDto {
  type?: BusinessType;
  planId?: string;
  startPeriods?: string[];
  consecutivePrefix?: string;
  logoUrl?: string;
  services?: CreateServiceItemDto[];
  branches?: CreateBranchItemDto[];
}

export function validateUpdateBusinessDto(body: unknown): UpdateBusinessDto {
  if (body == null || typeof body !== "object") {
    throw CustomError.badRequest("El body debe ser un objeto");
  }
  const b = body as Record<string, unknown>;
  const result: UpdateBusinessDto = {};

  if (b.name !== undefined) {
    throw CustomError.badRequest(
      "name no se puede editar después de crear el negocio"
    );
  }

  if (b.slug !== undefined) {
    throw CustomError.badRequest(
      "slug no se puede editar después de crear el negocio"
    );
  }

  const type = b.type;
  if (type !== undefined) {
    if (!isBusinessType(type)) {
      throw CustomError.badRequest(
        "El tipo de negocio debe ser barbería, peluquería o salón de belleza"
      );
    }
    result.type = type;
  }

  const planIdRaw = b.planId;
  if (planIdRaw !== undefined) {
    if (typeof planIdRaw !== "string" || planIdRaw.trim() === "") {
      throw CustomError.badRequest("planId debe ser un texto no vacío cuando se proporcione");
    }
    result.planId = planIdRaw.trim();
  }

  const subscriptionStatus = b.subscriptionStatus;
  if (subscriptionStatus !== undefined) {
    throw CustomError.badRequest(
      "subscriptionStatus no se puede enviar ni editar en negocios"
    );
  }

  if (b.startPeriods !== undefined) {
    result.startPeriods = validateAndNormalizeStartPeriods(
      b.startPeriods,
      "startPeriods"
    );
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
      "Se debe proporcionar al menos un campo editable (type, planId, startPeriods, consecutivePrefix, logoUrl, services, branches)"
    );
  }

  return result;
}
