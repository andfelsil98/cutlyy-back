import { CustomError } from "../../../domain/errors/custom-error";
import {
  formatName,
  isOnlyLettersNumbersAndSpaces,
  normalizeSpaces,
} from "../../../domain/utils/string.utils";
import type {
  BranchLocation,
  BranchScheduleDay,
  BranchScheduleSlot,
} from "../../../domain/interfaces/branch.interface";

/**
 * Normaliza y valida teléfono de sede: solo 57 + 10 dígitos.
 * Si viene con 57 al inicio debe ser exactamente 57 + 10 dígitos.
 * Si no viene con 57, debe ser exactamente 10 dígitos y se le agrega 57.
 */
function normalizeBranchPhone(rawPhone: string): string {
  const digitsOnly = rawPhone.replace(/\D+/g, "");
  if (digitsOnly.startsWith("57")) {
    if (digitsOnly.length !== 12) {
      throw CustomError.badRequest(
        "phone debe ser 57 seguido de exactamente 10 dígitos (12 dígitos en total)"
      );
    }
    return digitsOnly;
  }
  if (digitsOnly.length !== 10) {
    throw CustomError.badRequest(
      "phone debe ser 10 dígitos (ej: 3001112233) o 57 seguido de 10 dígitos (ej: 573001112233)"
    );
  }
  return "57" + digitsOnly;
}

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Body para actualizar una sede: imageGallery, location, phone, phoneHasWhatsapp y schedule obligatorias + campos opcionales + status. */
export interface UpdateBranchBodyDto {
  name?: string;
  address?: string;
  location: BranchLocation;
  phone: string;
  phoneHasWhatsapp: boolean;
  schedule: BranchScheduleDay[];
  imageGallery: string[];
  status?: "ACTIVE" | "INACTIVE";
}

function validateScheduleSlot(slot: unknown, index: number): BranchScheduleSlot {
  if (slot == null || typeof slot !== "object" || Array.isArray(slot)) {
    throw CustomError.badRequest(`slots[${index}] debe ser un objeto`);
  }

  const record = slot as Record<string, unknown>;
  const openingTimeRaw = record.openingTime;
  const closingTimeRaw = record.closingTime;

  if (typeof openingTimeRaw !== "string" || !HHMM_REGEX.test(openingTimeRaw.trim())) {
    throw CustomError.badRequest(`slots[${index}].openingTime debe tener formato HH:mm`);
  }
  if (typeof closingTimeRaw !== "string" || !HHMM_REGEX.test(closingTimeRaw.trim())) {
    throw CustomError.badRequest(`slots[${index}].closingTime debe tener formato HH:mm`);
  }

  const openingTime = openingTimeRaw.trim();
  const closingTime = closingTimeRaw.trim();
  if (closingTime <= openingTime) {
    throw CustomError.badRequest(`slots[${index}].closingTime debe ser mayor que openingTime`);
  }

  return { openingTime, closingTime };
}

function validateSchedule(scheduleInput: unknown): BranchScheduleDay[] {
  if (!Array.isArray(scheduleInput)) {
    throw CustomError.badRequest("schedule es requerido y debe ser un arreglo");
  }
  if (scheduleInput.length !== 7) {
    throw CustomError.badRequest("schedule debe incluir exactamente los 7 días (0 a 6)");
  }

  const seenDays = new Set<number>();

  const schedule = scheduleInput.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw CustomError.badRequest(`schedule[${index}] debe ser un objeto`);
    }

    const dayData = item as Record<string, unknown>;
    const dayRaw = dayData.day;
    const isOpenRaw = dayData.isOpen;
    const slotsRaw = dayData.slots;

    if (!Number.isInteger(dayRaw) || (dayRaw as number) < 0 || (dayRaw as number) > 6) {
      throw CustomError.badRequest(`schedule[${index}].day debe ser un entero entre 0 y 6`);
    }
    const day = dayRaw as number;
    if (seenDays.has(day)) {
      throw CustomError.badRequest(`schedule contiene day duplicado: ${day}`);
    }
    seenDays.add(day);

    if (typeof isOpenRaw !== "boolean") {
      throw CustomError.badRequest(`schedule[${index}].isOpen debe ser booleano`);
    }
    const isOpen = isOpenRaw;

    if (!Array.isArray(slotsRaw)) {
      throw CustomError.badRequest(`schedule[${index}].slots debe ser un arreglo`);
    }

    const slots = slotsRaw.map((slot, slotIndex) => validateScheduleSlot(slot, slotIndex));

    if (!isOpen && slots.length > 0) {
      throw CustomError.badRequest(`schedule[${index}].slots debe ser [] cuando isOpen es false`);
    }

    if (isOpen && slots.length === 0) {
      throw CustomError.badRequest(`schedule[${index}].slots debe incluir al menos 1 rango cuando isOpen es true`);
    }

    const sorted = [...slots].sort((a, b) => a.openingTime.localeCompare(b.openingTime));
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.openingTime < sorted[i - 1]!.closingTime) {
        throw CustomError.badRequest(`schedule[${index}].slots no debe tener traslapes`);
      }
    }

    return {
      day,
      isOpen,
      slots: sorted,
    };
  });

  for (let day = 0; day <= 6; day += 1) {
    if (!seenDays.has(day)) {
      throw CustomError.badRequest(`schedule debe incluir day=${day}`);
    }
  }

  return schedule.sort((a, b) => a.day - b.day);
}

/** Valida body: { name?, address?, location, phone, phoneHasWhatsapp, schedule, imageGallery, status? }. */
export function validateUpdateBranchDto(body: unknown): UpdateBranchBodyDto {
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
    if (!isOnlyLettersNumbersAndSpaces(nameNormalized)) {
      throw CustomError.badRequest("name solo puede contener letras, números y espacios (sin caracteres especiales)");
    }
    name = formatName(nameNormalized);
  }

  const addressRaw = b.address;
  let address: string | undefined;
  if (addressRaw !== undefined) {
    if (typeof addressRaw !== "string" || addressRaw.trim() === "") {
      throw CustomError.badRequest("address debe ser un texto no vacío cuando se proporcione");
    }
    address = normalizeSpaces(addressRaw);
  }

  const locationRaw = b.location;
  if (locationRaw == null || typeof locationRaw !== "object" || Array.isArray(locationRaw)) {
    throw CustomError.badRequest("location es requerido y debe ser un objeto con lat y lng");
  }
  const locationData = locationRaw as Record<string, unknown>;
  const latRaw = locationData.lat;
  const lngRaw = locationData.lng;

  if (typeof latRaw !== "number" || Number.isNaN(latRaw)) {
    throw CustomError.badRequest("location.lat es requerido y debe ser un número válido");
  }
  if (typeof lngRaw !== "number" || Number.isNaN(lngRaw)) {
    throw CustomError.badRequest("location.lng es requerido y debe ser un número válido");
  }

  const location: BranchLocation = { lat: latRaw, lng: lngRaw };

  const phoneRaw = b.phone;
  if (typeof phoneRaw !== "string" || phoneRaw.trim() === "") {
    throw CustomError.badRequest("phone es requerido y debe ser un texto no vacío");
  }
  const phone = normalizeBranchPhone(phoneRaw.trim());

  const phoneHasWhatsappRaw = b.phoneHasWhatsapp;
  if (typeof phoneHasWhatsappRaw !== "boolean") {
    throw CustomError.badRequest("phoneHasWhatsapp es requerido y debe ser booleano");
  }
  const phoneHasWhatsapp = phoneHasWhatsappRaw;

  const schedule = validateSchedule(b.schedule);

  const imageGalleryRaw = b.imageGallery;
  if (!Array.isArray(imageGalleryRaw)) {
    throw CustomError.badRequest("imageGallery es requerido y debe ser un arreglo de textos");
  }
  if (imageGalleryRaw.length === 0) {
    throw CustomError.badRequest("imageGallery debe incluir al menos 1 elemento");
  }

  const imageGallery = imageGalleryRaw.map((galleryItem, index) => {
    if (typeof galleryItem !== "string" || galleryItem.trim() === "") {
      throw CustomError.badRequest(`imageGallery[${index}] debe ser un texto no vacío`);
    }
    return galleryItem.trim();
  });

  const statusRaw = b.status;
  let status: "ACTIVE" | "INACTIVE" | undefined;
  if (statusRaw !== undefined) {
    if (statusRaw !== "ACTIVE" && statusRaw !== "INACTIVE") {
      throw CustomError.badRequest("El estado debe ser activo o inactivo cuando se proporcione");
    }
    status = statusRaw;
  }

  const result: UpdateBranchBodyDto = {
    location,
    phone,
    phoneHasWhatsapp,
    schedule,
    imageGallery,
  };

  if (name !== undefined) result.name = name;
  if (address !== undefined) result.address = address;
  if (status !== undefined) result.status = status;

  return result;
}

/** Valida el id de la sede (param en la ruta). */
export function validateBranchIdParam(id: unknown): string {
  if (id == null || typeof id !== "string" || id.trim() === "") {
    throw CustomError.badRequest("El parámetro id es requerido y debe ser un texto no vacío");
  }
  return id.trim();
}
