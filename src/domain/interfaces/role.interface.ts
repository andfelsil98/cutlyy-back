import type { RoleType } from "../constants/access-control.constants";

export interface Role {
  id: string;
  businessId?: string;
  name: string;
  type: RoleType;
  permissionsCount: number;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}
