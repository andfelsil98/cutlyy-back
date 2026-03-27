import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { Business } from "../../domain/interfaces/business.interface";
import type { Service } from "../../domain/interfaces/service.interface";
import type { PaginatedResult, PaginationParams } from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import type { CreateServicesBodyDto } from "../service/dtos/create-service.dto";
import type { UpdateServiceBodyDto } from "../service/dtos/update-service.dto";
import FirestoreService from "./firestore.service";
import { SchedulingIntegrityService } from "./scheduling-integrity.service";

const COLLECTION_NAME = "Services";
const BUSINESS_COLLECTION = "Businesses";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

export class ServiceService {
  constructor(
    private readonly schedulingIntegrityService: SchedulingIntegrityService =
      new SchedulingIntegrityService()
  ) {}

  async getAllServices(
    params: PaginationParams & { businessId?: string; id?: string; includeDeletes?: boolean }
  ): Promise<PaginatedResult<Service>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const includeDeletes = params.includeDeletes === true;
      const filters = [
        ...(includeDeletes
          ? []
          : [
              {
                field: "status" as const,
                operator: "in" as const,
                value: ["ACTIVE", "INACTIVE"],
              },
            ]),
        ...(params.businessId != null && params.businessId.trim() !== ""
          ? [{ field: "businessId" as const, operator: "==" as const, value: params.businessId.trim() }]
          : []),
        ...(params.id != null && params.id.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.id.trim() }]
          : []),
      ];
      return await FirestoreService.getAllPaginated<Service>(COLLECTION_NAME, { page, pageSize }, filters);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createServices(dto: CreateServicesBodyDto): Promise<Service[]> {
    try {
      const businesses = await FirestoreService.getAll<Business>(BUSINESS_COLLECTION, [
        { field: "id", operator: "==", value: dto.businessId },
      ]);
      if (businesses.length === 0) throw CustomError.notFound("No existe un negocio con este id");
      // Unicidad del nombre solo dentro del mismo negocio (mismo businessId).
      // Entre negocios distintos sí se puede repetir el nombre del servicio.
      const existingServices = await FirestoreService.getAll<Service>(COLLECTION_NAME, [
        { field: "businessId", operator: "==", value: dto.businessId },
      ]);
      const existingNameKeys = new Set(existingServices.map((s) => toNameKey(s.name)));

      const namesInRequest = new Set<string>();
      for (const item of dto.services) {
        const nameKey = toNameKey(item.name);
        if (existingNameKeys.has(nameKey)) {
          throw CustomError.conflict("A service with this name already exists for this business");
        }
        if (namesInRequest.has(nameKey)) {
          throw CustomError.conflict("Nombre de servicio duplicado en la solicitud");
        }
        namesInRequest.add(nameKey);
      }

      const created: Service[] = [];
      for (const item of dto.services) {
        const data = {
          businessId: dto.businessId,
          name: item.name,
          duration: item.duration,
          price: item.price,
          description: item.description ?? "",
          ...(item.imageUrl !== undefined && { imageUrl: item.imageUrl }),
          status: "ACTIVE" as const,
          createdAt: FirestoreDataBase.generateTimeStamp(),
        };
        const result = await FirestoreService.create(COLLECTION_NAME, data);
        created.push(result);
      }
      return created;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updateService(id: string, dto: UpdateServiceBodyDto): Promise<Service> {
    try {
      const services = await FirestoreService.getAll<Service>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (services.length === 0) throw CustomError.notFound("No existe un servicio con este id");

      if (dto.name !== undefined) {
        const existingServices = await FirestoreService.getAll<Service>(COLLECTION_NAME, [
          { field: "businessId", operator: "==", value: services[0]?.businessId },
        ]);
        const nameKey = toNameKey(dto.name);
        const nameTaken = existingServices.some(
          (s) => s.id !== id && toNameKey(s.name) === nameKey
        );
        if (nameTaken) throw CustomError.conflict("A service with this name already exists for this business");
      }

      const payload: Record<string, unknown> = {
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };
      if (dto.name !== undefined) payload.name = dto.name;
      if (dto.duration !== undefined) payload.duration = dto.duration;
      if (dto.price !== undefined) payload.price = dto.price;
      if (dto.description !== undefined) payload.description = dto.description;
      if (dto.imageUrl !== undefined) payload.imageUrl = dto.imageUrl;
      if (dto.status !== undefined) payload.status = dto.status;

      await FirestoreService.update(COLLECTION_NAME, id, payload);
      return await FirestoreService.getById<Service>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteService(id: string): Promise<Service> {
    try {
      const services = await FirestoreService.getAll<Service>(COLLECTION_NAME, [
        { field: "id", operator: "==", value: id },
      ]);
      if (services.length === 0) throw CustomError.notFound("No existe un servicio con este id");
      await this.schedulingIntegrityService.ensureServiceCanBeDeleted(services[0]!.id);
      const payload = {
        status: "DELETED" as const,
        deletedAt: FirestoreDataBase.generateTimeStamp(),
      };
      await FirestoreService.update(COLLECTION_NAME, id, payload);
      return await FirestoreService.getById<Service>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }
}
