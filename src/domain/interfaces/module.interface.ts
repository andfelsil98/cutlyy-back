import type { AccessEntityType } from "../constants/access-control.constants";

export interface Module {
  id: string;
  name: string;
  value: string;
  type: AccessEntityType;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}
