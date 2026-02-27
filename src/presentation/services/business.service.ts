import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type {
  Business,
  CreateBusinessCompleteResult,
} from "../../domain/interfaces/business.interface";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Branch } from "../../domain/interfaces/branch.interface";
import type { Service } from "../../domain/interfaces/service.interface";
import type { PaginatedResult, PaginationParams } from "../../domain/interfaces/pagination.interface";
import { MAX_PAGE_SIZE } from "../../domain/interfaces/pagination.interface";
import type { CreateBusinessDto } from "../business/dtos/create-business.dto";
import type { CreateBusinessCompleteDto } from "../business/dtos/create-business-complete.dto";
import type { UpdateBusinessDto } from "../business/dtos/update-business.dto";
import type { CreateBranchItemDto } from "../branch/dtos/create-branch.dto";
import type { CreateServiceItemDto } from "../service/dtos/create-service.dto";
import type { BranchService } from "./branch.service";
import FirestoreService from "./firestore.service";
import type { ServiceService } from "./service.service";
import type { UserService } from "./user.service";

const COLLECTION_NAME = "Businesses";
const SERVICES_COLLECTION = "Services";
const BRANCHES_COLLECTION = "Branches";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";
const USERS_COLLECTION = "Users";
const ROOT_OWNER_ROLE_ID = "kr3ECTOcAGHnsbvDAr4y";
const ROOT_SUPER_ADMIN_ID = "WyeIL50oCUFg9PBvB9m9";

function toNameKey(value: string): string {
  return value.trim().toLowerCase();
}

export class BusinessService {
  constructor(
    private readonly serviceService?: ServiceService,
    private readonly branchService?: BranchService,
    private readonly userService?: UserService
  ) {}

  async getAllBusinesses(
    params: PaginationParams & { id?: string }
  ): Promise<PaginatedResult<Business>> {
    try {
      const page = Math.max(1, params.page);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize));
      const filters = [
        {
          field: "status" as const,
          operator: "in" as const,
          value: ["ACTIVE", "INACTIVE", "PENDING"],
        },
        ...(params.id != null && params.id.trim() !== ""
          ? [{ field: "id" as const, operator: "==" as const, value: params.id.trim() }]
          : []),
      ];
      return await FirestoreService.getAllPaginated<Business>(
        COLLECTION_NAME,
        {
          page,
          pageSize,
        },
        filters
      );
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createBusiness(dto: CreateBusinessDto): Promise<Business> {
    try {
      const existing = await FirestoreService.getAll<Business>(COLLECTION_NAME);
      const incomingNameKey = toNameKey(dto.name);
      const duplicated = existing.some((business) => toNameKey(business.name) === incomingNameKey);
      if (duplicated) {
        throw CustomError.conflict("Ya existe un negocio con este nombre");
      }
      const data = {
        name: dto.name,
        type: dto.type,
        slug: dto.slug,
        employees: [] as string[],
        logoUrl: dto.logoUrl ?? "",
        status: "ACTIVE" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      };
      const result = await FirestoreService.create(COLLECTION_NAME, data);
      return result;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async createBusinessComplete(
    dto: CreateBusinessCompleteDto,
    opts: { creatorDocument: string }
  ): Promise<CreateBusinessCompleteResult> {
    try {
      const business = await this.createBusiness({
        name: dto.name,
        type: dto.type,
        slug: dto.slug,
        ...(dto.logoUrl !== undefined && dto.logoUrl !== "" && { logoUrl: dto.logoUrl }),
      });

      await this.ensureCreatorMembership(business.id, opts.creatorDocument);

      const requestedServices = dto.services ?? [];
      let services: Service[] = [];
      if (requestedServices.length > 0 && this.serviceService) {
        services = await this.serviceService.createServices({
          businessId: business.id,
          services: requestedServices,
        });
      }

      const requestedBranches = dto.branches ?? [];
      let branches: Branch[] = [];
      if (requestedBranches.length > 0 && this.branchService) {
        branches = await this.branchService.createBranches({
          businessId: business.id,
          branches: requestedBranches,
        });
      }

      return { business, services, branches };
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async updateBusiness(id: string, dto: UpdateBusinessDto): Promise<Business> {
    try {
      await FirestoreService.getById<Business>(COLLECTION_NAME, id);

      if (dto.name !== undefined) {
        const withSameName = await FirestoreService.getAll<Business>(
          COLLECTION_NAME,
          []
        );
        const incomingNameKey = toNameKey(dto.name);
        const otherWithSameName = withSameName.filter(
          (b) => b.id !== id && toNameKey(b.name) === incomingNameKey
        );
        if (otherWithSameName.length > 0) {
          throw CustomError.conflict("Ya existe un negocio con este nombre");
        }
      }

      const payload: Record<string, unknown> = {
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      };
      if (dto.name !== undefined) payload.name = dto.name;
      if (dto.type !== undefined) payload.type = dto.type;
      if (dto.logoUrl !== undefined) payload.logoUrl = dto.logoUrl;
      if (dto.slug !== undefined) payload.slug = dto.slug;

      await FirestoreService.update(COLLECTION_NAME, id, payload);

      if (dto.services !== undefined) {
        await this.syncServices(id, dto.services);
      }
      if (dto.branches !== undefined) {
        await this.syncBranches(id, dto.branches);
      }

      return await FirestoreService.getById<Business>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async deleteBusiness(id: string): Promise<Business> {
    try {
      const deletedAt = FirestoreDataBase.generateTimeStamp();
      const payload = {
        status: "DELETED" as const,
        deletedAt,
      };
      await FirestoreService.update(COLLECTION_NAME, id, payload);
      await this.markMembershipsAsDeletedByBusiness(id, deletedAt);
      return await FirestoreService.getById<Business>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  async toggleBusinessStatus(
    id: string,
    opts: { actorDocument: string }
  ): Promise<Business> {
    try {
      const business = await FirestoreService.getById<Business>(COLLECTION_NAME, id);

      if (business.status === "DELETED") {
        throw CustomError.badRequest("No se puede modificar el estado de un negocio eliminado");
      }

      let newStatus: "ACTIVE" | "INACTIVE";
      switch (business.status) {
        case "ACTIVE":
          newStatus = "INACTIVE";
          break;
        case "INACTIVE":
        case "PENDING":
          newStatus = "ACTIVE";
          break;
        default:
          newStatus = "ACTIVE";
          break;
      }

      await FirestoreService.update(COLLECTION_NAME, id, {
        status: newStatus,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });

      if (newStatus === "INACTIVE") {
        await this.markMembershipsAsInactiveByBusiness(id);
      } else {
        await this.ensureCreatorMembership(id, opts.actorDocument);
      }

      return await FirestoreService.getById<Business>(COLLECTION_NAME, id);
    } catch (error) {
      if (error instanceof CustomError) throw error;
      throw CustomError.internalServerError("Error interno del servidor");
    }
  }

  private async ensureCreatorMembership(
    businessId: string,
    creatorDocument: string
  ): Promise<void> {
    if (!this.userService) {
      throw CustomError.internalServerError(
        "No se pudo resolver el usuario creador del negocio"
      );
    }

    const creatorUser = await this.userService.getByDocument(creatorDocument.trim());
    if (!creatorUser) {
      throw CustomError.notFound(
        "No existe un usuario con el document del token para asignar membresía"
      );
    }

    const memberships = await FirestoreService.getAll<BusinessMembership>(
      BUSINESS_MEMBERSHIPS_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );
    const existingMembership = memberships.find(
      (membership) =>
        membership.userId === creatorUser.document || membership.userId === creatorUser.id
    );

    const now = FirestoreDataBase.generateTimeStamp();
    let membershipId: string;

    if (existingMembership) {
      membershipId = existingMembership.id;
      await FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membershipId, {
        userId: creatorUser.document,
        roleId: ROOT_SUPER_ADMIN_ID,
        status: "ACTIVE" as const,
        deletedAt: null,
        updatedAt: now,
      });
    } else {
      const createdMembership = await FirestoreService.create(
        BUSINESS_MEMBERSHIPS_COLLECTION,
        {
          businessId,
          userId: creatorUser.document,
          isEmployee: false,
          roleId: ROOT_SUPER_ADMIN_ID,
          status: "ACTIVE" as const,
          createdAt: now,
        }
      );
      membershipId = createdMembership.id;
    }

    await FirestoreService.createInSubcollection(
      USERS_COLLECTION,
      creatorUser.id,
      "businessMemberships",
      {
        id: membershipId,
        businessId,
      }
    );
  }

  private async markMembershipsAsDeletedByBusiness(
    businessId: string,
    deletedAt: ReturnType<typeof FirestoreDataBase.generateTimeStamp>
  ): Promise<void> {
    const memberships = await FirestoreService.getAll<BusinessMembership>(
      BUSINESS_MEMBERSHIPS_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const updates = memberships.map((membership) => {
      if (membership.status === "DELETED") {
        return Promise.resolve();
      }
      return FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membership.id, {
        status: "DELETED" as const,
        deletedAt,
      });
    });

    await Promise.all(updates);
  }

  private async markMembershipsAsInactiveByBusiness(
    businessId: string
  ): Promise<void> {
    const memberships = await FirestoreService.getAll<BusinessMembership>(
      BUSINESS_MEMBERSHIPS_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const updates = memberships.map((membership) => {
      if (membership.status === "DELETED" || membership.status === "INACTIVE") {
        return Promise.resolve();
      }
      return FirestoreService.update(BUSINESS_MEMBERSHIPS_COLLECTION, membership.id, {
        status: "INACTIVE" as const,
        updatedAt: FirestoreDataBase.generateTimeStamp(),
      });
    });

    await Promise.all(updates);
  }

  private async syncServices(
    businessId: string,
    services: CreateServiceItemDto[]
  ): Promise<void> {
    const existingServices = await FirestoreService.getAll<Service>(
      SERVICES_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const existingByName = new Map<string, Service>();
    existingServices.forEach((service) => {
      const nameKey = toNameKey(service.name);
      if (!existingByName.has(nameKey)) {
        existingByName.set(nameKey, service);
      }
    });

    const namesInRequest = new Set<string>();
    for (const item of services) {
      const nameKey = toNameKey(item.name);
      if (namesInRequest.has(nameKey)) {
        throw CustomError.conflict("Nombre de servicio duplicado en la solicitud");
      }
      namesInRequest.add(nameKey);

      const existing = existingByName.get(nameKey);
      if (existing) {
        await FirestoreService.update(SERVICES_COLLECTION, existing.id, {
          duration: item.duration,
          price: item.price,
          description: item.description ?? "",
          status: "ACTIVE",
          deletedAt: null,
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        });
        continue;
      }

      await FirestoreService.create(SERVICES_COLLECTION, {
        businessId,
        name: item.name,
        duration: item.duration,
        price: item.price,
        description: item.description ?? "",
        status: "ACTIVE" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });
    }

    const toDelete = existingServices.filter(
      (service) => !namesInRequest.has(toNameKey(service.name))
    );
    await Promise.all(
      toDelete.map((service) =>
        FirestoreService.update(SERVICES_COLLECTION, service.id, {
          status: "DELETED" as const,
          deletedAt: FirestoreDataBase.generateTimeStamp(),
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        })
      )
    );
  }

  private async syncBranches(
    businessId: string,
    branches: CreateBranchItemDto[]
  ): Promise<void> {
    const existingBranches = await FirestoreService.getAll<Branch>(
      BRANCHES_COLLECTION,
      [{ field: "businessId", operator: "==", value: businessId }]
    );

    const existingByName = new Map<string, Branch>();
    existingBranches.forEach((branch) => {
      const nameKey = toNameKey(branch.name);
      if (!existingByName.has(nameKey)) {
        existingByName.set(nameKey, branch);
      }
    });

    const namesInRequest = new Set<string>();
    for (const item of branches) {
      const nameKey = toNameKey(item.name);
      if (namesInRequest.has(nameKey)) {
        throw CustomError.conflict("Nombre de sede duplicado en la solicitud");
      }
      namesInRequest.add(nameKey);

      const existing = existingByName.get(nameKey);
      if (existing) {
        await FirestoreService.update(BRANCHES_COLLECTION, existing.id, {
          address: item.address,
          openingTime: item.openingTime,
          closingTime: item.closingTime,
          status: "ACTIVE",
          deletedAt: null,
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        });
        continue;
      }

      await FirestoreService.create(BRANCHES_COLLECTION, {
        businessId,
        name: item.name,
        address: item.address,
        openingTime: item.openingTime,
        closingTime: item.closingTime,
        status: "ACTIVE" as const,
        createdAt: FirestoreDataBase.generateTimeStamp(),
      });
    }

    const toDelete = existingBranches.filter(
      (branch) => !namesInRequest.has(toNameKey(branch.name))
    );
    await Promise.all(
      toDelete.map((branch) =>
        FirestoreService.update(BRANCHES_COLLECTION, branch.id, {
          status: "DELETED" as const,
          deletedAt: FirestoreDataBase.generateTimeStamp(),
          updatedAt: FirestoreDataBase.generateTimeStamp(),
        })
      )
    );
  }
}
