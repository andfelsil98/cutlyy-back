import { CustomError } from "../../../domain/errors/custom-error";
import { formatName, normalizeSpaces } from "../../../domain/utils/string.utils";

/** Body para actualizar un servicio: description obligatoria + demás campos opcionales + status. */
export interface UpdateServiceBodyDto {
  name?: string;
  duration?: number;
  price?: number;
  description: string;
  imageUrl?: string;
  status?: "ACTIVE" | "INACTIVE";
}

/** Valida body: { name?, duration?, price?, description, imageUrl?, status? }. */
export function validateUpdateServiceDto(body: unknown): UpdateServiceBodyDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto con al menos un campo a actualizar");
  }
  const b = body as Record<string, unknown>;

  const nameRaw = b.name;
  let name: string | undefined;
  if (nameRaw !== undefined) {
    if (typeof nameRaw !== "string" || nameRaw.trim() === "") {
      throw CustomError.badRequest("name debe ser un texto no vacío cuando se proporcione");
    }
    const nameNormalized = normalizeSpaces(nameRaw);
    name = formatName(nameNormalized);
  }

  const duration = b.duration;
  if (duration !== undefined) {
    if (typeof duration !== "number" || Number.isNaN(duration) || duration < 0) {
      throw CustomError.badRequest("duration debe ser un número no negativo cuando se proporcione");
    }
  }

  const price = b.price;
  if (price !== undefined) {
    if (typeof price !== "number" || Number.isNaN(price) || price < 0) {
      throw CustomError.badRequest("price debe ser un número no negativo cuando se proporcione");
    }
  }

  const descriptionRaw = b.description;
  if (typeof descriptionRaw !== "string" || descriptionRaw.trim() === "") {
    throw CustomError.badRequest("description es requerido y debe ser un texto no vacío");
  }
  const description = normalizeSpaces(String(descriptionRaw));

  const imageUrlRaw = b.imageUrl;
  let imageUrl: string | undefined;
  if (imageUrlRaw !== undefined) {
    if (typeof imageUrlRaw !== "string") {
      throw CustomError.badRequest("imageUrl debe ser un texto cuando se proporcione");
    }
    imageUrl = imageUrlRaw.trim();
  }

  const statusRaw = b.status;
  let status: "ACTIVE" | "INACTIVE" | undefined;
  if (statusRaw !== undefined) {
    if (statusRaw !== "ACTIVE" && statusRaw !== "INACTIVE") {
      throw CustomError.badRequest("El estado debe ser activo o inactivo cuando se proporcione");
    }
    status = statusRaw;
  }

  const result: UpdateServiceBodyDto = { description };
  if (name !== undefined) result.name = name;
  if (duration !== undefined) result.duration = duration;
  if (price !== undefined) result.price = price;
  if (imageUrl !== undefined) result.imageUrl = imageUrl;
  if (status !== undefined) result.status = status;

  return result;
}

/** Valida el id del servicio (param en la ruta). */
export function validateServiceIdParam(id: unknown): string {
  if (id == null || typeof id !== "string" || id.trim() === "") {
    throw CustomError.badRequest("El parámetro id es requerido y debe ser un texto no vacío");
  }
  return id.trim();
}
