import type { Timestamp } from "firebase-admin/firestore";

export interface PushNotificationSubscription {
  id: string;
  deviceId: string;
  token: string;
  platform: string;
  notificationPermission: "granted";
  userAgent?: string;
  language?: string;
  status: "ACTIVE" | "INACTIVE";
  createdAt: Timestamp | string;
  updatedAt?: Timestamp | string;
  lastSeenAt?: Timestamp | string;
  lastErrorCode?: string;
}
