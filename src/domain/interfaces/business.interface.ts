import type { Branch } from "./branch.interface";
import type { Service } from "./service.interface";
import type { Usage } from "./usage.interface";

export interface BusinessDeletionSummary {
  appointments: number;
  bookings: number;
  branches: number;
  memberships: number;
  metrics: number;
  reviews: number;
  roles: number;
  services: number;
  users: number;
}

export interface BusinessDeletionState {
  status: "RUNNING" | "FAILED" | "COMPLETED";
  stage:
    | "mark-business-as-deleted"
    | "load-deletion-context"
    | "delete-appointment-status-tasks"
    | "delete-business-usage"
    | "delete-reviews"
    | "delete-metrics"
    | "delete-user-business-membership-links"
    | "delete-business-memberships"
    | "delete-roles"
    | "delete-appointments"
    | "delete-bookings"
    | "delete-services"
    | "delete-branches"
    | "delete-storage-folder"
    | "COMPLETED";
  eventId?: string;
  summary?: BusinessDeletionSummary;
  lastError?: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface Business {
  id: string;
  name: string;
  type: "BARBERSHOP" | "HAIRSALON" | "BEAUTYSALON";
  status: "ACTIVE" | "INACTIVE" | "PENDING" | "DELETED";
  subscriptionStatus: "ACTIVE" | "INACTIVE";
  planId: string;
  slug: string;
  consecutivePrefix: string;
  employees: string[];
  logoUrl?: string;
  usage?: Array<Usage & { id: string }>;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  deletion?: BusinessDeletionState;
}

/** Resultado de crear un negocio completo (negocio + servicios + sedes). */
export interface CreateBusinessCompleteResult {
  business: Business;
  services: Service[];
  branches: Branch[];
}

export interface BusinessDeletionStatusResponse {
  businessId: string;
  businessStatus: Business["status"];
  deletion: BusinessDeletionState | null;
}
