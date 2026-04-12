export interface BusinessMembership {
  id: string;
  businessId?: string | null;
  /** Documento de identidad del usuario (no el id de Firestore). */
  userId: string;
  score?: number;
  reviews?: number;
  isEmployee: boolean;
  branchId?: string | null;
  roleId: string | null;
  status: "ACTIVE" | "INACTIVE" | "DELETED" | "PENDING";
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export const BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "PENDING",
] as const;

export type BusinessMembershipQueryableStatus =
  (typeof BUSINESS_MEMBERSHIP_QUERYABLE_STATUSES)[number];
