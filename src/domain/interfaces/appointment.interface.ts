export type AppointmentStatus =
  | "CREATED"
  | "CANCELLED"
  | "FINISHED"
  | "PENDING";

export interface AppointmentServiceSelection {
  id: string;
  startTime: string;
  endTime: string;
}

export interface Appointment {
  id: string;
  businessId: string;
  branchId: string;
  date: string;
  services: AppointmentServiceSelection[];
  employeeId?: string;
  clientId: string;
  status: AppointmentStatus;
  createdAt: string;
  cancelledAt?: string;
  updatedAt?: string;
}
