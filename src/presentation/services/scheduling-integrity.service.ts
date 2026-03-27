import { CustomError } from "../../domain/errors/custom-error";
import type { AppointmentStatus } from "../../domain/interfaces/appointment.interface";
import type { BookingStatus } from "../../domain/interfaces/booking.interface";
import FirestoreService from "./firestore.service";

const BOOKINGS_COLLECTION = "Bookings";
const APPOINTMENTS_COLLECTION = "Appointments";
const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["CREATED"];
const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = ["CREATED", "IN_PROGRESS"];

function normalizeIdentifiers(identifiers: string[]): string[] {
  return Array.from(
    new Set(
      identifiers
        .map((identifier) => identifier.trim())
        .filter((identifier) => identifier !== "")
    )
  );
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

  async ensureServiceCanBeDeleted(serviceId: string): Promise<void> {
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
      throw CustomError.badRequest(
        "No se puede eliminar el servicio porque está asociado a citas activas"
      );
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
}
