export type ReviewTargetType = "EMPLOYEE" | "BRANCH";

export interface Review {
  id: string;
  businessId: string;
  branchId: string;
  targetType: ReviewTargetType;
  targetId: string;
  score: number;
  comment?: string;
  reviewerId: string;
  reviewerName: string;
  bookingId: string;
  appointmentId?: string;
  createdAt: string;
  updatedAt?: string;
}
