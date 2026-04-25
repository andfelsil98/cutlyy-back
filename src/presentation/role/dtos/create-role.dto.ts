import { CustomError } from "../../../domain/errors/custom-error";
import {
  isRoleType,
  type RoleType,
} from "../../../domain/constants/access-control.constants";
import { formatName } from "../../../domain/utils/string.utils";

export interface CreateRoleDto {
  name: string;
  type: RoleType;
  /** Requerido solo cuando type es BUSINESS. */
  businessId?: string;
  /** Arreglo de ids de permisos a asociar al rol. */
  permissions: string[];
}

export function validateCreateRoleDto(body: unknown): CreateRoleDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const b = body as Record<string, unknown>;

  const nameRaw = b.name;
  if (typeof nameRaw !== "string" || nameRaw.trim() === "") {
    throw CustomError.badRequest("name es requerido y debe ser un texto no vacío");
  }
  const name = formatName(nameRaw);

  const typeRaw = b.type;
  if (!isRoleType(typeRaw)) {
    throw CustomError.badRequest(
      "El tipo de rol debe ser de negocio, multinegocio o global"
    );
  }
  const type = typeRaw;

  const businessIdRaw = (b as Record<string, unknown>).businessId;
  let businessId: string | undefined;
  if (type !== "BUSINESS") {
    if (typeof businessIdRaw === "string" && businessIdRaw.trim() !== "") {
      throw CustomError.badRequest(
        "businessId no debe enviarse cuando el tipo de rol es multinegocio o global"
      );
    }
  } else {
    if (typeof businessIdRaw !== "string" || businessIdRaw.trim() === "") {
      throw CustomError.badRequest(
        "businessId es requerido y debe ser un texto no vacío cuando el tipo de rol es de negocio"
      );
    }
    businessId = businessIdRaw.trim();
  }

  const permissionsRaw = b.permissions;
  if (!Array.isArray(permissionsRaw)) {
    throw CustomError.badRequest("permissions es requerido y debe ser un arreglo");
  }
  if (permissionsRaw.length === 0) {
    throw CustomError.badRequest("Se requiere al menos un permiso");
  }

  const permissions = permissionsRaw.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw CustomError.badRequest(
        `El permissionId en la posición ${index} es requerido y debe ser un texto no vacío`
      );
    }
    return item.trim();
  });

  return {
    name,
    type,
    ...(businessId !== undefined && { businessId }),
    permissions,
  };
}
