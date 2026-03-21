import { randomBytes } from "node:crypto";
import { CustomError } from "../../domain/errors/custom-error";
import type { Booking } from "../../domain/interfaces/booking.interface";
import type { Business } from "../../domain/interfaces/business.interface";
import {
  buildBookingConsecutive,
  isValidConsecutivePrefix,
  normalizeConsecutivePrefix,
} from "../../domain/utils/booking-consecutive.utils";
import FirestoreService from "./firestore.service";

const BOOKINGS_COLLECTION = "Bookings";
const BUSINESSES_COLLECTION = "Businesses";
const RANDOM_SUFFIX_LENGTH = 8;
const MAX_GENERATION_ATTEMPTS = 3;
const ALPHANUMERIC_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export class BookingConsecutiveService {
  async generateUniqueConsecutive(
    businessId: string,
    cachedBusiness?: Business
  ): Promise<string> {
    const business = cachedBusiness ?? await FirestoreService.getById<Business>(
      BUSINESSES_COLLECTION,
      businessId
    );
    const consecutivePrefix = normalizeConsecutivePrefix(business.consecutivePrefix);

    if (!isValidConsecutivePrefix(consecutivePrefix)) {
      throw CustomError.badRequest(
        "El negocio no tiene un consecutivePrefix válido configurado"
      );
    }

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = buildBookingConsecutive(
        consecutivePrefix,
        this.generateRandomSuffix(RANDOM_SUFFIX_LENGTH)
      );
      const matches = await FirestoreService.getAll<Booking>(BOOKINGS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
        { field: "consecutive", operator: "==", value: candidate },
      ]);

      if (matches.length === 0) {
        return candidate;
      }
    }

    throw CustomError.internalServerError(
      "No se pudo generar un consecutivo único para el agendamiento"
    );
  }

  private generateRandomSuffix(length: number): string {
    const bytes = randomBytes(length);
    let result = "";

    for (let index = 0; index < length; index += 1) {
      result += ALPHANUMERIC_CHARS[bytes[index]! % ALPHANUMERIC_CHARS.length];
    }

    return result;
  }
}
