import { CustomError } from "../../../domain/errors/custom-error";
import type { CreateBusinessDto } from "./create-business.dto";
import { validateCreateBusinessDto } from "./create-business.dto";

/** Body para crear negocio: solo datos propios del negocio. */
export type CreateBusinessCompleteDto = CreateBusinessDto;

/** Valida body de creación de negocio y rechaza asociaciones embebidas. */
export function validateCreateBusinessCompleteDto(body: unknown): CreateBusinessCompleteDto {
  const businessDto = validateCreateBusinessDto(body);
  const b = (body ?? {}) as Record<string, unknown>;

  if (b.services !== undefined) {
    throw CustomError.badRequest(
      "services no debe enviarse al crear un negocio; debe gestionarse por separado"
    );
  }
  if (b.branches !== undefined) {
    throw CustomError.badRequest(
      "branches no debe enviarse al crear un negocio; debe gestionarse por separado"
    );
  }

  return businessDto;
}
