import type { AccessEntityType } from "../constants/access-control.constants";

export interface Permission {
  id: string;
  name: string;
  value: string;
  description?: string;
  moduleId: string;
  type: AccessEntityType;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}
