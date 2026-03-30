import { envs } from "../../config/envs";
import { FirestoreDataBase } from "../../data/firestore/firestore.database";
import { CustomError } from "../../domain/errors/custom-error";
import type { BusinessMembership } from "../../domain/interfaces/business-membership.interface";
import type { Business } from "../../domain/interfaces/business.interface";
import type { PushNotificationSubscription } from "../../domain/interfaces/push-notification.interface";
import type { User } from "../../domain/interfaces/user.interface";
import { logger } from "../../infrastructure/logger/logger";
import type { UpsertPushNotificationSubscriptionDto } from "../push-notifications/dtos/upsert-push-notification-subscription.dto";
import FirestoreService from "./firestore.service";
import { UserService } from "./user.service";

const USERS_COLLECTION = "Users";
const BUSINESSES_COLLECTION = "Businesses";
const BUSINESS_MEMBERSHIPS_COLLECTION = "BusinessMemberships";
const PUSH_NOTIFICATION_SUBCOLLECTION = "pushNotificationSubscriptions";
const MAX_MULTICAST_TOKENS = 500;

const INVALID_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

interface NotifyBookingCreatedParams {
  businessId: string;
  branchId: string;
  bookingId: string;
  bookingConsecutive: string;
  clientDocument: string;
  employeeIds: string[];
  appointments: Array<{
    date: string;
    startTime: string;
  }>;
}

interface PushNotificationRecipient {
  userId: string;
  subscriptionId: string;
  token: string;
}

interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  data: Record<string, string>;
}

export class PushNotificationService {
  constructor(
    private readonly userService: UserService = new UserService()
  ) {}

  async upsertSubscription(
    requesterDocument: string,
    dto: UpsertPushNotificationSubscriptionDto
  ): Promise<{ deviceId: string; status: "ACTIVE"; message: string }> {
    const user = await this.ensureUserByDocument(requesterDocument);
    const db = FirestoreDataBase.getDB();
    const now = FirestoreDataBase.generateTimeStamp();

    await this.detachDeviceFromOtherUsers(user.id, dto.deviceId);

    const subscriptionRef = db
      .collection(USERS_COLLECTION)
      .doc(user.id)
      .collection(PUSH_NOTIFICATION_SUBCOLLECTION)
      .doc(dto.deviceId);
    const existingSnapshot = await subscriptionRef.get();
    const existingCreatedAt = existingSnapshot.exists
      ? existingSnapshot.data()?.createdAt
      : undefined;

    await subscriptionRef.set(
      {
        id: dto.deviceId,
        deviceId: dto.deviceId,
        token: dto.token,
        platform: dto.platform,
        notificationPermission: dto.notificationPermission,
        ...(dto.userAgent !== undefined && { userAgent: dto.userAgent }),
        ...(dto.language !== undefined && { language: dto.language }),
        status: "ACTIVE" as const,
        createdAt: existingCreatedAt ?? now,
        updatedAt: now,
        lastSeenAt: now,
        lastErrorCode: "",
      },
      { merge: true }
    );

    return {
      deviceId: dto.deviceId,
      status: "ACTIVE",
      message: "Notificaciones activadas correctamente en este dispositivo.",
    };
  }

  async deleteSubscription(
    requesterDocument: string,
    deviceId: string
  ): Promise<{ deviceId: string; message: string }> {
    const user = await this.ensureUserByDocument(requesterDocument);

    await FirestoreService.deleteSubcollectionDocument(
      USERS_COLLECTION,
      user.id,
      PUSH_NOTIFICATION_SUBCOLLECTION,
      deviceId
    );

    return {
      deviceId,
      message: "Suscripción push eliminada correctamente.",
    };
  }

  async notifyBookingCreated(params: NotifyBookingCreatedParams): Promise<void> {
    if (!envs.PUSH_NOTIFICATIONS_ENABLED) return;
    if (params.appointments.length === 0) return;

    const recipients = await this.getRecipientsForEmployees(
      params.businessId,
      params.employeeIds
    );
    if (recipients.length === 0) return;

    const sanitizedClientDocument = params.clientDocument.trim();
    const [business, client] = await Promise.all([
      FirestoreService.getById<Business>(BUSINESSES_COLLECTION, params.businessId),
      sanitizedClientDocument !== ""
        ? this.userService.getByDocument(sanitizedClientDocument)
        : Promise.resolve(null),
    ]);

    const payload = this.buildBookingCreatedPayload(params, business, client);
    await this.sendToRecipients(recipients, payload);
  }

  private async ensureUserByDocument(document: string): Promise<User> {
    const sanitizedDocument = document.trim();
    if (sanitizedDocument === "") {
      throw CustomError.unauthorized("El documento del usuario autenticado es inválido");
    }

    const user = await this.userService.getByDocument(sanitizedDocument);
    if (!user) {
      throw CustomError.notFound(
        "No existe un usuario interno asociado al documento autenticado"
      );
    }

    return user;
  }

  private async detachDeviceFromOtherUsers(
    currentUserId: string,
    deviceId: string
  ): Promise<void> {
    const db = FirestoreDataBase.getDB();
    const snapshot = await db
      .collectionGroup(PUSH_NOTIFICATION_SUBCOLLECTION)
      .where("deviceId", "==", deviceId)
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    let hasDeletes = false;

    snapshot.docs.forEach((doc) => {
      const ownerUserId = doc.ref.parent.parent?.id ?? "";
      if (ownerUserId !== "" && ownerUserId !== currentUserId) {
        batch.delete(doc.ref);
        hasDeletes = true;
      }
    });

    if (hasDeletes) {
      await batch.commit();
    }
  }

  private async getRecipientsForEmployees(
    businessId: string,
    employeeIds: string[]
  ): Promise<PushNotificationRecipient[]> {
    const normalizedEmployeeIds = Array.from(
      new Set(
        employeeIds
          .map((employeeId) => employeeId.trim())
          .filter((employeeId) => employeeId !== "")
      )
    );
    if (normalizedEmployeeIds.length === 0) return [];

    const [memberships, resolvedUsers] = await Promise.all([
      FirestoreService.getAll<BusinessMembership>(BUSINESS_MEMBERSHIPS_COLLECTION, [
        { field: "businessId", operator: "==", value: businessId },
      ]),
      Promise.all(
        normalizedEmployeeIds.map((employeeId) =>
          this.resolveUserFromMembershipIdentifier(employeeId)
        )
      ),
    ]);

    const allowedMembershipIdentifiers = new Set<string>(normalizedEmployeeIds);
    resolvedUsers.forEach((user) => {
      if (!user) return;
      allowedMembershipIdentifiers.add(user.id);
      allowedMembershipIdentifiers.add(user.document);
    });

    const activeEmployeeIdentifiers = new Set<string>(
      memberships
        .filter(
          (membership) =>
            membership.status === "ACTIVE" &&
            membership.isEmployee === true &&
            allowedMembershipIdentifiers.has(membership.userId.trim())
        )
        .map((membership) => membership.userId.trim())
        .filter((membershipUserId) => membershipUserId !== "")
    );

    if (activeEmployeeIdentifiers.size === 0) return [];

    const uniqueUsers = Array.from(new Map(
      resolvedUsers
        .filter((user): user is User => user != null)
        .filter(
          (user) =>
            activeEmployeeIdentifiers.has(user.id) ||
            activeEmployeeIdentifiers.has(user.document)
        )
        .map((user) => [user.id, user])
    ).values());
    if (uniqueUsers.length === 0) return [];

    const subscriptionsByUser = await Promise.all(
      uniqueUsers.map(async (user) => {
        const subscriptions =
          await FirestoreService.getAllFromSubcollection<PushNotificationSubscription>(
            USERS_COLLECTION,
            user.id,
            PUSH_NOTIFICATION_SUBCOLLECTION,
            {
              filters: [{ field: "status", operator: "==", value: "ACTIVE" }],
            }
          );

        return subscriptions.map((subscription) => ({
          userId: user.id,
          subscriptionId: subscription.id,
          token: subscription.token.trim(),
        }));
      })
    );

    const tokenDeduplication = new Set<string>();

    return subscriptionsByUser
      .flat()
      .filter((subscription) => {
        if (subscription.token === "") return false;
        if (tokenDeduplication.has(subscription.token)) return false;

        tokenDeduplication.add(subscription.token);
        return true;
      });
  }

  private async resolveUserFromMembershipIdentifier(
    userIdentifier: string
  ): Promise<User | null> {
    const normalizedIdentifier = userIdentifier.trim();
    if (normalizedIdentifier === "") return null;

    const userByDocument = await this.userService.getByDocument(normalizedIdentifier);
    if (userByDocument) return userByDocument;

    return this.userService.getById(normalizedIdentifier);
  }

  private buildBookingCreatedPayload(
    params: NotifyBookingCreatedParams,
    business: Business,
    client: User | null
  ): PushNotificationPayload {
    const businessName = business.name?.trim() || "Cutlyy";
    const clientName = client?.name?.trim() || "Un cliente";
    const bookingConsecutive =
      params.bookingConsecutive.trim() !== ""
        ? params.bookingConsecutive.trim()
        : params.bookingId;
    const firstAppointment = params.appointments[0];
    if (!firstAppointment) {
      throw CustomError.badRequest(
        "Debes enviar al menos una cita para construir la notificación push"
      );
    }
    const firstAppointmentLabel = `${this.formatDateLabel(
      firstAppointment.date
    )} a las ${firstAppointment.startTime}`;

    const body =
      params.appointments.length === 1
        ? `${clientName} creó el agendamiento ${bookingConsecutive} para ${firstAppointmentLabel}.`
        : `${clientName} creó el agendamiento ${bookingConsecutive} con ${params.appointments.length} citas. Primera cita: ${firstAppointmentLabel}.`;

    return {
      title: `${businessName}: nuevo agendamiento`,
      body,
      url: `/app/booking/${params.bookingId}`,
      tag: `booking-created-${params.bookingId}`,
      data: {
        title: `${businessName}: nuevo agendamiento`,
        body,
        url: `/app/booking/${params.bookingId}`,
        tag: `booking-created-${params.bookingId}`,
        notificationType: "BOOKING_CREATED",
        bookingId: params.bookingId,
        businessId: params.businessId,
        branchId: params.branchId,
        bookingConsecutive,
      },
    };
  }

  private async sendToRecipients(
    recipients: PushNotificationRecipient[],
    payload: PushNotificationPayload
  ): Promise<void> {
    if (recipients.length === 0) return;

    const messaging = FirestoreDataBase.getAdmin().messaging();

    for (const chunk of this.chunkRecipients(recipients, MAX_MULTICAST_TOKENS)) {
      const response = await messaging.sendEachForMulticast({
        tokens: chunk.map((recipient) => recipient.token),
        data: payload.data,
        webpush: {
          headers: {
            Urgency: "high",
          },
        },
      });

      if (response.failureCount > 0) {
        logger.warn(
          `[PushNotificationService] ${response.failureCount} notificaciones push fallaron de ${chunk.length} intentos.`
        );
      }

      await this.cleanupInvalidSubscriptions(chunk, response.responses);
    }

    logger.info(
      `[PushNotificationService] Notificacion push '${payload.tag}' enviada a ${recipients.length} dispositivos.`
    );
  }

  private chunkRecipients(
    recipients: PushNotificationRecipient[],
    size: number
  ): PushNotificationRecipient[][] {
    const chunks: PushNotificationRecipient[][] = [];
    for (let index = 0; index < recipients.length; index += size) {
      chunks.push(recipients.slice(index, index + size));
    }
    return chunks;
  }

  private async cleanupInvalidSubscriptions(
    recipients: PushNotificationRecipient[],
    responses: Array<{ success: boolean; error?: { code?: string } }>
  ): Promise<void> {
    const invalidRecipients = recipients.filter((recipient, index) => {
      const response = responses[index];
      const errorCode = response?.error?.code ?? "";

      return !response?.success && INVALID_TOKEN_ERROR_CODES.has(errorCode);
    });

    if (invalidRecipients.length === 0) return;

    const db = FirestoreDataBase.getDB();
    const batch = db.batch();

    invalidRecipients.forEach((recipient) => {
      const docRef = db
        .collection(USERS_COLLECTION)
        .doc(recipient.userId)
        .collection(PUSH_NOTIFICATION_SUBCOLLECTION)
        .doc(recipient.subscriptionId);

      batch.delete(docRef);
    });

    await batch.commit();
  }

  private formatDateLabel(date: string): string {
    const [year, month, day] = date.split("-");
    if (!year || !month || !day) return date;
    return `${day}/${month}/${year}`;
  }
}
