import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { Timestamp } from "firebase-admin/firestore";
import { CustomError } from "../../domain/errors/custom-error";
import type { Appointment } from "../../domain/interfaces/appointment.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import type { Business } from "../../domain/interfaces/business.interface";
import type {
  PaginatedResult,
  PaginationParams,
} from "../../domain/interfaces/pagination.interface";
import type { User } from "../../domain/interfaces/user.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import type { CreateAppointmentDto } from "../appointment/dtos/create-appointment.dto";
import FirestoreService from "./firestore.service";

const COLLECTION_NAME = "Appointments";
const BUSINESS_COLLECTION = "Businesses";
const BRANCH_COLLECTION = "Branches";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";
const USERS_COLLECTION = "Users";

interface AppointmentServiceSelectionStored {
  id: string;
  startTime: string;
  endTime: string;
}

interface AppointmentServiceSelectionResponse {
  id: string;
  startTime: string;
  endTime: string;
}

type AppointmentStored = Omit<Appointment, "services" | "date"> & {
  date: Timestamp | string;
  services: AppointmentServiceSelectionStored[] | AppointmentServiceSelectionResponse[];
};

export class AppointmentService {
  async getAllAppointments(
    params: PaginationParams & {
      businessId?: string;
      id?: string;
      employeeId?: string;
      startDate?: string;
      endDate?: string;
      sameDate?: boolean;
    }
  ): Promise<PaginatedResult<Appointment>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const useSameDate = params.sameDate === true && params.startDate != null;
      const useRange = !useSameDate && (params.startDate != null || params.endDate != null);
      const filters = [
        ...(params.businessId != null && params.businessId.trim() !== ""
          ? [
              {
                field: "businessId" as const,
                operator: "==" as const,
                value: params.businessId.trim(),
              },
            ]
          : []),
        ...(params.id != null && params.id.trim() !== ""
          ? [
              {
                field: "id" as const,
                operator: "==" as const,
                value: params.id.trim(),
              },
            ]
          : []),
        ...(params.employeeId != null && params.employeeId.trim() !== ""
          ? [
              {
                field: "employeeId" as const,
                operator: "==" as const,
                value: params.employeeId.trim(),
              },
            ]
          : []),
        ...(useSameDate
          ? [
              {
                field: "date" as const,
                operator: "==" as const,
                value: params.startDate!,
              },
            ]
          : []),
        ...(!useSameDate && params.startDate != null
          ? [
              {
                field: "date" as const,
                operator: ">=" as const,
                value: params.startDate,
              },
            ]
          : []),
        ...(!useSameDate && params.endDate != null
          ? [
              {
                field: "date" as const,
                operator: "<=" as const,
                value: params.endDate,
              },
            ]
          : []),
      ];

      const result = await FirestoreService.getAllPaginated<AppointmentStored>(
        COLLECTION_NAME,
        { page, pageSize },
        filters,
        useRange
          ? {
              field: "date",
              direction: "desc",
            }
          : undefined
      );
      return {
        ...result,
        data: result.data.map((appointment) =>
          this.mapAppointmentToResponse(appointment)
        ),
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createAppointment(dto: CreateAppointmentDto): Promise<Appointment> {
    try {
      await this.ensureBusinessExists(dto.businessId);
      await this.ensureBranchBelongsToBusiness(dto.branchId, dto.businessId);
      if (dto.employeeId !== undefined) {
        await this.ensureEmployeeIsActiveInBusiness(dto.employeeId, dto.businessId);
      }

      const servicesForStorage = dto.services.map((service) => ({
        id: service.id,
        startTime: service.startTime,
        endTime: service.endTime,
      }));

      const data = {
        businessId: dto.businessId,
        branchId: dto.branchId,
        date: dto.date,
        services: servicesForStorage,
        ...(dto.employeeId !== undefined && { employeeId: dto.employeeId }),
        clientId: dto.clientId,
        status: "CREATED" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };

      const created = await FirestoreService.create<{
        businessId: string;
        branchId: string;
        date: string;
        services: AppointmentServiceSelectionStored[];
        employeeId?: string;
        clientId: string;
        status: "CREATED";
        createdAt: ReturnType<typeof FirestoreDataBase.generateTimeStamp>;
      }>(COLLECTION_NAME, data);

      return this.mapAppointmentToResponse(created as unknown as AppointmentStored);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async ensureBusinessExists(businessId: string): Promise<void> {
    const businesses = await FirestoreService.getAll<Business>(BUSINESS_COLLECTION, [
      { field: "id", operator: "==", value: businessId },
    ]);

    if (businesses.length === 0) {
      throw CustomError.notFound("No existe un negocio con este id");
    }

    if (businesses[0]!.status === "DELETED") {
      throw CustomError.badRequest(
        "No se pueden crear citas para un negocio eliminado"
      );
    }
  }

  private async ensureBranchBelongsToBusiness(
    branchId: string,
    businessId: string
  ): Promise<void> {
    const branches = await FirestoreService.getAll<Branch>(BRANCH_COLLECTION, [
      { field: "id", operator: "==", value: branchId },
    ]);

    if (branches.length === 0) {
      throw CustomError.notFound("No existe una sede con este id");
    }

    const branch = branches[0]!;
    if (branch.status === "DELETED") {
      throw CustomError.badRequest(
        "No se pueden crear citas para una sede eliminada"
      );
    }

    if (branch.businessId !== businessId) {
      throw CustomError.badRequest(
        "La sede indicada no pertenece al negocio enviado"
      );
    }
  }

  private async ensureEmployeeIsActiveInBusiness(
    employeeId: string,
    businessId: string
  ): Promise<void> {
    const [memberships, usersById, usersByDocument] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(BUSINESS_MEMBERSHIPS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      FirestoreService.getAll<User>(USERS_COLLECTION, [
        { field: "id", operator: "==", value: employeeId },
      ]),
      FirestoreService.getAll<User>(USERS_COLLECTION, [
        { field: "document", operator: "==", value: employeeId },
      ]),
    ]);

    const allowedUserIds = new Set<string>([employeeId]);
    const userById = usersById[0];
    const userByDocument = usersByDocument[0];
    if (userById) {
      allowedUserIds.add(userById.id);
      allowedUserIds.add(userById.document);
    }
    if (userByDocument) {
      allowedUserIds.add(userByDocument.id);
      allowedUserIds.add(userByDocument.document);
    }

    const isValidEmployee = memberships.some(
      (membership) =>
        allowedUserIds.has(membership.userId) &&
        membership.status === "ACTIVE" &&
        membership.isEmployee === true
    );

    if (!isValidEmployee) {
      throw CustomError.badRequest(
        "employeeId debe pertenecer a una membresía ACTIVE con isEmployee=true en este negocio"
      );
    }
  }

  private mapAppointmentToResponse(appointment: AppointmentStored): Appointment {
    const services = appointment.services.map((service) => ({
      id: service.id,
      startTime: service.startTime,
      endTime: service.endTime,
    }));

    return {
      id: appointment.id,
      businessId: appointment.businessId,
      branchId: appointment.branchId,
      date:
        appointment.date instanceof Timestamp
          ? appointment.date.toDate().toISOString().split("T")[0]!
          : appointment.date,
      services,
      ...(appointment.employeeId !== undefined && {
        employeeId: appointment.employeeId,
      }),
      clientId: appointment.clientId,
      status: appointment.status,
      createdAt: appointment.createdAt,
      ...(appointment.cancelledAt !== undefined && {
        cancelledAt: appointment.cancelledAt,
      }),
      ...(appointment.updatedAt !== undefined && {
        updatedAt: appointment.updatedAt,
      }),
    };
  }
}
