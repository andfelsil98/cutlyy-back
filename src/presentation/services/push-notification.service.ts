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

interface AuthenticatedPushRequester {
  document?: string;
  email?: string;
}

interface NotifyBookingNotificationParams {
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
    requester: AuthenticatedPushRequester,
    dto: UpsertPushNotificationSubscriptionDto
  ): Promise<{ deviceId: string; status: "ACTIVE"; message: string }> {
    const user = await this.ensureUserFromRequester(requester);
    const db = FirestoreDataBase.getDB();
    const now = FirestoreDataBase.generateTimeStamp();

    await this.detachDeviceFromOtherUsers(user.id, dto.deviceId).catch(
      (detachDeviceError) => {
        const detail =
          detachDeviceError instanceof Error
            ? detachDeviceError.message
            : typeof detachDeviceError === "string"
              ? detachDeviceError
              : JSON.stringify(detachDeviceError);

        logger.warn(
          `[PushNotificationService] No se pudo depurar el deviceId ${dto.deviceId} en otros usuarios. detalle=${detail}`
        );
      }
    );

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
    requester: AuthenticatedPushRequester,
    deviceId: string
  ): Promise<{ deviceId: string; message: string }> {
    const user = await this.ensureUserFromRequester(requester);

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

  async notifyBookingCreated(params: NotifyBookingNotificationParams): Promise<void> {
    if (!envs.PUSH_NOTIFICATIONS_ENABLED) return;
    if (params.appointments.length === 0) return;

    logger.info(
      `[PushNotificationService] Preparando push BOOKING_CREATED. bookingId=${params.bookingId}, businessId=${params.businessId}, branchId=${params.branchId}, employeeIds=${this.summarizeIdentifiers(params.employeeIds)}, appointments=${params.appointments.length}`
    );

    const notificationContext = await this.resolveBookingNotificationContext(params);
    if (!notificationContext) {
      logger.warn(
        `[PushNotificationService] No se encontraron destinatarios para push BOOKING_CREATED. bookingId=${params.bookingId}, businessId=${params.businessId}, employeeIds=${this.summarizeIdentifiers(params.employeeIds)}`
      );
      return;
    }
    const { recipients, business, client } = notificationContext;

    const payload = this.buildBookingCreatedPayload(params, business, client);
    await this.sendToRecipients(recipients, payload);
  }

  async notifyBookingCancelled(params: NotifyBookingNotificationParams): Promise<void> {
    if (!envs.PUSH_NOTIFICATIONS_ENABLED) return;
    if (params.appointments.length === 0) return;

    logger.info(
      `[PushNotificationService] Preparando push BOOKING_CANCELLED. bookingId=${params.bookingId}, businessId=${params.businessId}, branchId=${params.branchId}, employeeIds=${this.summarizeIdentifiers(params.employeeIds)}, appointments=${params.appointments.length}`
    );

    const notificationContext = await this.resolveBookingNotificationContext(params);
    if (!notificationContext) {
      logger.warn(
        `[PushNotificationService] No se encontraron destinatarios para push BOOKING_CANCELLED. bookingId=${params.bookingId}, businessId=${params.businessId}, employeeIds=${this.summarizeIdentifiers(params.employeeIds)}`
      );
      return;
    }
    const { recipients, business, client } = notificationContext;

    const payload = this.buildBookingCancelledPayload(params, business, client);
    await this.sendToRecipients(recipients, payload);
  }

  private async ensureUserFromRequester(
    requester: AuthenticatedPushRequester
  ): Promise<User> {
    const sanitizedDocument = requester.document?.trim() ?? "";
    const sanitizedEmail = requester.email?.trim().toLowerCase() ?? "";

    const user =
      sanitizedDocument !== ""
        ? await this.userService.getByDocument(sanitizedDocument)
        : sanitizedEmail !== ""
          ? await this.userService.getByEmail(sanitizedEmail)
          : null;
    if (!user) {
      throw CustomError.notFound(
        "No existe un usuario interno asociado a la sesión autenticada"
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

    logger.info(
      `[PushNotificationService] Resolviendo destinatarios. businessId=${businessId}, employeeIds=${this.summarizeIdentifiers(normalizedEmployeeIds)}`
    );

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

    logger.info(
      `[PushNotificationService] Candidatos resueltos. businessId=${businessId}, memberships=${memberships.length}, resolvedUsers=${resolvedUsers.filter((user) => user != null).length}, activeEmployeeIdentifiers=${this.summarizeIdentifiers(Array.from(activeEmployeeIdentifiers))}, userIds=${this.summarizeIdentifiers(uniqueUsers.map((user) => user.id))}`
    );

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
    const recipients = subscriptionsByUser
      .flat()
      .filter((subscription) => {
        if (subscription.token === "") return false;
        if (tokenDeduplication.has(subscription.token)) return false;

        tokenDeduplication.add(subscription.token);
        return true;
      });

    logger.info(
      `[PushNotificationService] Suscripciones activas resueltas. businessId=${businessId}, recipients=${recipients.length}, subscriptionIds=${this.summarizeIdentifiers(recipients.map((recipient) => recipient.subscriptionId))}, tokenRefs=${this.summarizeIdentifiers(recipients.map((recipient) => this.maskToken(recipient.token)))}`
    );

    return recipients;
  }

  private async resolveBookingNotificationContext(
    params: NotifyBookingNotificationParams
  ): Promise<{
    recipients: PushNotificationRecipient[];
    business: Business;
    client: User | null;
  } | null> {
    const recipients = await this.getRecipientsForEmployees(
      params.businessId,
      params.employeeIds
    );
    if (recipients.length === 0) return null;

    const sanitizedClientDocument = params.clientDocument.trim();
    const [business, client] = await Promise.all([
      FirestoreService.getById<Business>(BUSINESSES_COLLECTION, params.businessId),
      sanitizedClientDocument !== ""
        ? this.userService.getByDocument(sanitizedClientDocument)
        : Promise.resolve(null),
    ]);

    return {
      recipients,
      business,
      client,
    };
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
    params: NotifyBookingNotificationParams,
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
    )} a las ${this.formatTimeLabel(firstAppointment.startTime)}`;

    const body =
      params.appointments.length === 1
        ? `${clientName} creó el agendamiento ${bookingConsecutive} para ${firstAppointmentLabel}.`
        : `${clientName} creó el agendamiento ${bookingConsecutive}. Revisa el detalle para ver las citas programadas.`;

    return {
      title: `${businessName}: nuevo agendamiento`,
      body,
      url: `/admin/booking/${params.bookingId}`,
      tag: `booking-created-${params.bookingId}`,
      data: {
        title: `${businessName}: nuevo agendamiento`,
        body,
        url: `/admin/booking/${params.bookingId}`,
        tag: `booking-created-${params.bookingId}`,
        notificationType: "BOOKING_CREATED",
        bookingId: params.bookingId,
        businessId: params.businessId,
        branchId: params.branchId,
        bookingConsecutive,
      },
    };
  }

  private buildBookingCancelledPayload(
    params: NotifyBookingNotificationParams,
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
    )} a las ${this.formatTimeLabel(firstAppointment.startTime)}`;

    const body =
      params.appointments.length === 1
        ? `${clientName} canceló el agendamiento ${bookingConsecutive} programado para ${firstAppointmentLabel}.`
        : `${clientName} canceló el agendamiento ${bookingConsecutive}. Revisa el detalle para ver las citas afectadas.`;

    return {
      title: `${businessName}: agendamiento cancelado`,
      body,
      url: `/admin/booking/${params.bookingId}`,
      tag: `booking-cancelled-${params.bookingId}`,
      data: {
        title: `${businessName}: agendamiento cancelado`,
        body,
        url: `/admin/booking/${params.bookingId}`,
        tag: `booking-cancelled-${params.bookingId}`,
        notificationType: "BOOKING_CANCELLED",
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
    const notificationLink = this.resolveFrontendNotificationLink(payload.url);

    for (const chunk of this.chunkRecipients(recipients, MAX_MULTICAST_TOKENS)) {
      logger.info(
        `[PushNotificationService] Enviando push '${payload.tag}' a chunk de ${chunk.length} dispositivos. link=${notificationLink}, tokenRefs=${this.summarizeIdentifiers(chunk.map((recipient) => this.maskToken(recipient.token)))}`
      );

      const response = await messaging.sendEachForMulticast({
        tokens: chunk.map((recipient) => recipient.token),
        data: payload.data,
        webpush: {
          headers: {
            Urgency: "high",
          },
          fcmOptions: {
            link: notificationLink,
          },
        },
      });

      if (response.failureCount > 0) {
        const failureDetails = chunk
          .map((recipient, index) => ({
            recipient,
            response: response.responses[index],
          }))
          .filter(({ response }) => !response?.success)
          .map(({ recipient, response }) => (
            `userId=${recipient.userId}, subscriptionId=${recipient.subscriptionId}, tokenRef=${this.maskToken(recipient.token)}, code=${response?.error?.code ?? "UNKNOWN"}, message=${response?.error?.message ?? "Sin mensaje"}`
          ));

        logger.warn(
          `[PushNotificationService] ${response.failureCount} notificaciones push fallaron de ${chunk.length} intentos. detalle=${failureDetails.join(" | ")}`
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

  private summarizeIdentifiers(values: string[], maxItems = 10): string {
    const normalizedValues = values
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (normalizedValues.length === 0) return "[]";

    const displayedValues = normalizedValues.slice(0, maxItems);
    const suffix =
      normalizedValues.length > maxItems
        ? ` ... (+${normalizedValues.length - maxItems})`
        : "";

    return `[${displayedValues.join(", ")}]${suffix}`;
  }

  private maskToken(token: string): string {
    const normalizedToken = token.trim();
    if (normalizedToken.length <= 12) return normalizedToken;
    return `${normalizedToken.slice(0, 6)}...${normalizedToken.slice(-6)}`;
  }

  private resolveFrontendNotificationLink(targetUrl: string): string {
    const normalizedBaseUrl = envs.FRONTEND_APP_BASE_URL.trim();
    if (normalizedBaseUrl === "") {
      throw CustomError.internalServerError(
        "FRONTEND_APP_BASE_URL es requerido para construir el link absoluto de notificaciones push"
      );
    }

    return new URL(targetUrl, normalizedBaseUrl).toString();
  }

  private formatDateLabel(date: string): string {
    const [yearRaw, monthRaw, dayRaw] = date.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);

    if (
      !yearRaw ||
      !monthRaw ||
      !dayRaw ||
      Number.isNaN(year) ||
      Number.isNaN(month) ||
      Number.isNaN(day)
    ) {
      return date;
    }

    const parsedDate = new Date(year, month - 1, day);
    if (
      parsedDate.getFullYear() !== year ||
      parsedDate.getMonth() !== month - 1 ||
      parsedDate.getDate() !== day
    ) {
      return date;
    }

    const formatter = new Intl.DateTimeFormat("es-CO", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const parts = formatter.formatToParts(parsedDate);
    const formattedDay = parts.find((part) => part.type === "day")?.value;
    const formattedMonth = parts.find((part) => part.type === "month")?.value;
    const formattedYear = parts.find((part) => part.type === "year")?.value;

    if (!formattedDay || !formattedMonth || !formattedYear) {
      return formatter.format(parsedDate);
    }

    return `${formattedDay} de ${formattedMonth} ${formattedYear}`;
  }

  private formatTimeLabel(time: string): string {
    const [hoursRaw, minutesRaw] = time.split(":");
    const hours24 = Number(hoursRaw);
    const minutes = Number(minutesRaw);

    if (
      !hoursRaw ||
      !minutesRaw ||
      Number.isNaN(hours24) ||
      Number.isNaN(minutes) ||
      hours24 < 0 ||
      hours24 > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      return time;
    }

    const suffix = hours24 >= 12 ? "pm" : "am";
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;

    return `${hours12}:${String(minutes).padStart(2, "0")}${suffix}`;
  }
}
