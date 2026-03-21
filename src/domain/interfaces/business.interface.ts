import type { Branch } from "./branch.interface";
import type { Service } from "./service.interface";

export interface Business {
  id: string;
  name: string;
  type: "BARBERSHOP" | "HAIRSALON" | "BEAUTYSALON";
  status: "ACTIVE" | "INACTIVE" | "PENDING" | "DELETED";
  slug: string;
  consecutivePrefix: string;
  employees: string[];
  logoUrl?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

/** Resultado de crear un negocio completo (negocio + servicios + sedes). */
export interface CreateBusinessCompleteResult {
  business: Business;
  services: Service[];
  branches: Branch[];
}
