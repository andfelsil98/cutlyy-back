import { CustomError } from "../../domain/errors/custom-error";
import type { AppointmentStatus } from "../../domain/interfaces/appointment.interface";
import type { BookingStatus } from "../../domain/interfaces/booking.interface";
import type { BranchScheduleDay } from "../../domain/interfaces/branch.interface";
import { Timestamp } from "firebase-admin/firestore";
import FirestoreService from "./firestore.service";

const BOOKINGS_COLLECTION = "Bookings";
const APPOINTMENTS_COLLECTION = "Appointments";
const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["CREATED"];
const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = ["CREATED", "IN_PROGRESS"];

interface AppointmentScheduleSelectionStored {
  startTime: string;
  endTime: string;
}

interface StoredAppointmentScheduleCandidate {
  id: string;
  date?: string | Timestamp;
  startTime?: string;
  endTime?: string;
  status: AppointmentStatus;
  bookingId?: string;
  services?: AppointmentScheduleSelectionStored[];
}

export interface AppointmentScheduleCandidateInput {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  bookingId?: string;
}

interface AppointmentReference {
  appointmentId: string;
  bookingId?: string;
}

type AppointmentScheduleConflictReason =
  | "INVALID_DATE"
  | "INVALID_TIME_RANGE"
  | "DAY_CLOSED"
  | "OUT_OF_SCHEDULE";

interface AppointmentScheduleConflict {
  appointmentId: string;
  bookingId: string;
  date: string;
  ranges: Array<{ startTime: string; endTime: string }>;
  reason: AppointmentScheduleConflictReason;
}

interface EnsureActiveAppointmentsRespectBranchScheduleInput {
  schedule: BranchScheduleDay[];
  branchId?: string;
  appointmentIds?: string[];
  fallbackBookingId?: string;
  errorMessagePrefix: string;
}

interface ListActiveAppointmentScheduleConflictsInput {
  schedule: BranchScheduleDay[];
  branchId?: string;
  appointmentIds?: string[];
  fallbackBookingId?: string;
}

function normalizeIdentifiers(identifiers: string[]): string[] {
  return Array.from(
    new Set(
      identifiers
        .map((identifier) => identifier.trim())
        .filter((identifier) => identifier !== "")
    )
  );
}

function normalizeAppointmentReferences(
  references: AppointmentReference[],
  fallbackBookingId?: string
): AppointmentReference[] {
  const normalizedFallbackBookingId = fallbackBookingId?.trim() ?? "";
  const byAppointmentId = new Map<string, AppointmentReference>();

  references.forEach((reference) => {
    const appointmentId = reference.appointmentId.trim();
    if (appointmentId === "") return;

    const bookingId = reference.bookingId?.trim() || normalizedFallbackBookingId || undefined;
    if (!byAppointmentId.has(appointmentId)) {
      byAppointmentId.set(appointmentId, {
        appointmentId,
        ...(bookingId != null && { bookingId }),
      });
      return;
    }

    const existing = byAppointmentId.get(appointmentId)!;
    if (existing.bookingId == null && bookingId != null) {
      byAppointmentId.set(appointmentId, {
        appointmentId,
        bookingId,
      });
    }
  });

  return Array.from(byAppointmentId.values());
}

export class SchedulingIntegrityService {
  async ensureBranchCanBeDeleted(branchId: string): Promise<void> {
    const normalizedBranchId = branchId.trim();
    if (normalizedBranchId === "") {
      throw CustomError.badRequest("branchId es requerido");
    }

    const activeBookings = await FirestoreService.getAll<{ id: string }>(
      BOOKINGS_COLLECTION,
      [
        { field: "branchId", operator: "==", value: normalizedBranchId },
        { field: "status", operator: "in", value: ACTIVE_BOOKING_STATUSES },
      ],
      undefined,
      ["id"]
    );

    if (activeBookings.length > 0) {
      throw CustomError.badRequest(
        "No se puede eliminar la sede porque está asociada a agendamientos activos"
      );
    }
  }

  async ensureActiveAppointmentsRespectBranchSchedule(
    input: EnsureActiveAppointmentsRespectBranchScheduleInput
  ): Promise<void> {
    const conflicts = await this.listActiveAppointmentScheduleConflicts(input);
    this.throwScheduleConflicts(input.errorMessagePrefix, conflicts);
  }

  async ensureAppointmentCandidatesRespectBranchSchedule(input: {
    schedule: BranchScheduleDay[];
    appointments: AppointmentScheduleCandidateInput[];
    fallbackBookingId?: string;
    errorMessagePrefix: string;
  }): Promise<void> {
    const fallbackBookingId = input.fallbackBookingId?.trim() ?? "";
    const conflicts = input.appointments
      .map<StoredAppointmentScheduleCandidate>((appointment) => ({
        id: appointment.id,
        date: appointment.date,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        status: appointment.status,
        ...(appointment.bookingId?.trim() != null && appointment.bookingId.trim() !== ""
          ? { bookingId: appointment.bookingId.trim() }
          : fallbackBookingId !== ""
            ? { bookingId: fallbackBookingId }
            : {}),
      }))
      .filter((appointment) =>
        ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status)
      )
      .map((appointment) =>
        this.buildScheduleConflict(appointment, input.schedule)
      )
      .filter((conflict): conflict is AppointmentScheduleConflict => conflict != null);

    this.throwScheduleConflicts(input.errorMessagePrefix, conflicts);
  }

  private throwScheduleConflicts(
    errorMessagePrefix: string,
    conflicts: AppointmentScheduleConflict[]
  ): void {
    if (conflicts.length === 0) return;

    const summarizedConflicts = conflicts
      .slice(0, 3)
      .map((conflict) => {
        const rangesSummary =
          conflict.ranges.length > 0
            ? conflict.ranges
                .map((range) => `${range.startTime}-${range.endTime}`)
                .join(", ")
            : "sin horario válido";

        return `${conflict.appointmentId} (${conflict.date} ${rangesSummary})`;
      })
      .join("; ");

    const remainingConflicts =
      conflicts.length > 3 ? ` y ${conflicts.length - 3} más` : "";

    throw CustomError.badRequest(
      `${errorMessagePrefix}: ${summarizedConflicts}${remainingConflicts}`
    );
  }

  async listActiveAppointmentScheduleConflicts(
    input: ListActiveAppointmentScheduleConflictsInput
  ): Promise<AppointmentScheduleConflict[]> {
    const hasBranchId =
      typeof input.branchId === "string" && input.branchId.trim() !== "";
    const hasAppointmentIds =
      Array.isArray(input.appointmentIds) &&
      normalizeIdentifiers(input.appointmentIds).length > 0;

    if (!hasBranchId && !hasAppointmentIds) {
      throw CustomError.badRequest(
        "Se requiere branchId o appointmentIds para validar integridad de horarios"
      );
    }

    const appointments = hasBranchId
      ? await this.getActiveAppointmentsForBranch(input.branchId!.trim())
      : await this.getAppointmentsByIds(
          normalizeIdentifiers(input.appointmentIds ?? []),
          input.fallbackBookingId
        );

    return appointments
      .filter((appointment) =>
        ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status)
      )
      .map((appointment) =>
        this.buildScheduleConflict(appointment, input.schedule)
      )
      .filter((conflict): conflict is AppointmentScheduleConflict => conflict != null);
  }

  async ensureServiceCanBeDeleted(serviceId: string): Promise<void> {
    await this.ensureServiceHasNoActiveAppointments(
      serviceId,
      "No se puede eliminar el servicio porque está asociado a citas activas"
    );
  }

  async ensureServiceCanBeInactivated(serviceId: string): Promise<void> {
    await this.ensureServiceHasNoActiveAppointments(
      serviceId,
      "No se puede inactivar el servicio porque está asociado a citas activas"
    );
  }

  private async ensureServiceHasNoActiveAppointments(
    serviceId: string,
    errorMessage: string
  ): Promise<void> {
    const normalizedServiceId = serviceId.trim();
    if (normalizedServiceId === "") {
      throw CustomError.badRequest("serviceId es requerido");
    }

    const activeAppointments = await FirestoreService.getAll<{ id: string }>(
      APPOINTMENTS_COLLECTION,
      [
        { field: "serviceId", operator: "==", value: normalizedServiceId },
        { field: "status", operator: "in", value: ACTIVE_APPOINTMENT_STATUSES },
      ],
      undefined,
      ["id"]
    );

    if (activeAppointments.length > 0) {
      throw CustomError.badRequest(errorMessage);
    }
  }

  async ensureEmployeeCanBeDeleted(employeeIdentifiers: string[]): Promise<void> {
    const normalizedIdentifiers = normalizeIdentifiers(employeeIdentifiers);
    if (normalizedIdentifiers.length === 0) {
      throw CustomError.badRequest("employeeId es requerido");
    }

    const employeeFilter =
      normalizedIdentifiers.length === 1
        ? {
            field: "employeeId" as const,
            operator: "==" as const,
            value: normalizedIdentifiers[0]!,
          }
        : {
            field: "employeeId" as const,
            operator: "in" as const,
            value: normalizedIdentifiers,
          };

    const activeAppointments = await FirestoreService.getAll<{ id: string }>(
      APPOINTMENTS_COLLECTION,
      [
        employeeFilter,
        { field: "status", operator: "in", value: ACTIVE_APPOINTMENT_STATUSES },
      ],
      undefined,
      ["id"]
    );

    if (activeAppointments.length > 0) {
      throw CustomError.badRequest(
        "No se puede eliminar el empleado porque está asociado a citas activas"
      );
    }
  }

  private async getActiveAppointmentsForBranch(
    branchId: string
  ): Promise<StoredAppointmentScheduleCandidate[]> {
    const normalizedBranchId = branchId.trim();
    if (normalizedBranchId === "") {
      throw CustomError.badRequest("branchId es requerido");
    }

    const activeBookings = await FirestoreService.getAll<{
      appointments?: string[];
    }>(
      BOOKINGS_COLLECTION,
      [
        { field: "branchId", operator: "==", value: normalizedBranchId },
        { field: "status", operator: "in", value: ACTIVE_BOOKING_STATUSES },
      ],
      undefined,
      ["appointments"]
    );

    const appointmentReferences = activeBookings.flatMap((booking) =>
      (booking.appointments ?? [])
        .map((appointmentId) => appointmentId.trim())
        .filter((appointmentId) => appointmentId !== "")
        .map((appointmentId) => ({
          appointmentId,
          bookingId: booking.id,
        }))
    );

    return this.getAppointmentsByReferences(appointmentReferences);
  }

  private async getAppointmentsByIds(
    appointmentIds: string[],
    fallbackBookingId?: string
  ): Promise<StoredAppointmentScheduleCandidate[]> {
    const appointmentReferences = appointmentIds.map((appointmentId) => ({
      appointmentId,
      ...(fallbackBookingId != null &&
        fallbackBookingId.trim() !== "" && {
          bookingId: fallbackBookingId.trim(),
        }),
    }));

    return this.getAppointmentsByReferences(appointmentReferences, fallbackBookingId);
  }

  private async getAppointmentsByReferences(
    references: AppointmentReference[],
    fallbackBookingId?: string
  ): Promise<StoredAppointmentScheduleCandidate[]> {
    const normalizedReferences = normalizeAppointmentReferences(
      references,
      fallbackBookingId
    );
    if (normalizedReferences.length === 0) return [];

    const bookingIdByAppointmentId = new Map(
      normalizedReferences.map((reference) => [
        reference.appointmentId,
        reference.bookingId ?? "",
      ])
    );

    const CHUNK_SIZE = 30;
    const chunks: string[][] = [];
    for (let index = 0; index < normalizedReferences.length; index += CHUNK_SIZE) {
      chunks.push(
        normalizedReferences
          .slice(index, index + CHUNK_SIZE)
          .map((reference) => reference.appointmentId)
      );
    }

    const results = await Promise.all(
      chunks.map((chunk) =>
        FirestoreService.getAll<StoredAppointmentScheduleCandidate>(
          APPOINTMENTS_COLLECTION,
          [{ field: "id", operator: "in", value: chunk }],
          undefined,
          ["date", "startTime", "endTime", "status", "bookingId", "services"]
        )
      )
    );

    return results.flat().map((appointment) => {
      const bookingId =
        appointment.bookingId?.trim() ||
        bookingIdByAppointmentId.get(appointment.id) ||
        "";

      return {
        ...appointment,
        ...(bookingId !== "" && { bookingId }),
      };
    });
  }

  private buildScheduleConflict(
    appointment: StoredAppointmentScheduleCandidate,
    schedule: BranchScheduleDay[]
  ): AppointmentScheduleConflict | null {
    const normalizedDate = this.normalizeDateValue(appointment.date);
    const ranges = this.resolveAppointmentRanges(appointment);

    if (normalizedDate == null) {
      return {
        appointmentId: appointment.id,
        bookingId: appointment.bookingId?.trim() ?? "",
        date: "(fecha inválida)",
        ranges,
        reason: "INVALID_DATE",
      };
    }

    if (ranges.length === 0) {
      return {
        appointmentId: appointment.id,
        bookingId: appointment.bookingId?.trim() ?? "",
        date: normalizedDate,
        ranges,
        reason: "INVALID_TIME_RANGE",
      };
    }

    const dayOfWeek = this.resolveDayOfWeek(normalizedDate);
    if (dayOfWeek == null) {
      return {
        appointmentId: appointment.id,
        bookingId: appointment.bookingId?.trim() ?? "",
        date: normalizedDate,
        ranges,
        reason: "INVALID_DATE",
      };
    }

    const daySchedule = schedule.find((day) => day.day === dayOfWeek);
    if (daySchedule == null || !daySchedule.isOpen || daySchedule.slots.length === 0) {
      return {
        appointmentId: appointment.id,
        bookingId: appointment.bookingId?.trim() ?? "",
        date: normalizedDate,
        ranges,
        reason: "DAY_CLOSED",
      };
    }

    const hasInvalidRange = ranges.some((range) => {
      const startMinutes = this.timeToMinutes(range.startTime);
      const endMinutes = this.timeToMinutes(range.endTime);

      if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
        return true;
      }

      return !daySchedule.slots.some((slot) => {
        const openingMinutes = this.timeToMinutes(slot.openingTime);
        const closingMinutes = this.timeToMinutes(slot.closingTime);
        if (openingMinutes == null || closingMinutes == null) {
          return false;
        }

        return (
          startMinutes >= openingMinutes && endMinutes <= closingMinutes
        );
      });
    });

    if (!hasInvalidRange) return null;

    return {
      appointmentId: appointment.id,
      bookingId: appointment.bookingId?.trim() ?? "",
      date: normalizedDate,
      ranges,
      reason: "OUT_OF_SCHEDULE",
    };
  }

  private resolveAppointmentRanges(
    appointment: StoredAppointmentScheduleCandidate
  ): Array<{ startTime: string; endTime: string }> {
    const startTime = appointment.startTime?.trim() ?? "";
    const endTime = appointment.endTime?.trim() ?? "";
    if (startTime !== "" && endTime !== "") {
      return [{ startTime, endTime }];
    }

    return (appointment.services ?? [])
      .map((service) => ({
        startTime: service.startTime?.trim() ?? "",
        endTime: service.endTime?.trim() ?? "",
      }))
      .filter(
        (range) => range.startTime !== "" && range.endTime !== ""
      );
  }

  private normalizeDateValue(value: string | Timestamp | undefined): string | null {
    if (typeof value === "string") {
      const trimmedValue = value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) return trimmedValue;

      const parsedValue = Date.parse(trimmedValue);
      if (Number.isNaN(parsedValue)) return null;

      return new Date(parsedValue).toISOString().split("T")[0] ?? null;
    }

    if (value instanceof Timestamp) {
      return value.toDate().toISOString().split("T")[0] ?? null;
    }

    return null;
  }

  private timeToMinutes(value: string): number | null {
    const trimmedValue = value.trim();
    const hhmmMatch = trimmedValue.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (hhmmMatch) {
      return Number(hhmmMatch[1]) * 60 + Number(hhmmMatch[2]);
    }

    const parsedMillis = Date.parse(trimmedValue);
    if (Number.isNaN(parsedMillis)) return null;

    const parsedDate = new Date(parsedMillis);
    return parsedDate.getUTCHours() * 60 + parsedDate.getUTCMinutes();
  }

  private resolveDayOfWeek(date: string): number | null {
    const match = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsedDate = new Date(year, month - 1, day);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.getFullYear() !== year ||
      parsedDate.getMonth() !== month - 1 ||
      parsedDate.getDate() !== day
    ) {
      return null;
    }

    return parsedDate.getDay();
  }
}
