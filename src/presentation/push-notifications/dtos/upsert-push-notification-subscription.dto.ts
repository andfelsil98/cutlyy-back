import { CustomError } from "../../../domain/errors/custom-error";
import { normalizeSpaces } from "../../../domain/utils/string.utils";

export interface UpsertPushNotificationSubscriptionDto {
  deviceId: string;
  token: string;
  platform: string;
  notificationPermission: "granted";
  userAgent?: string;
  language?: string;
}

export function validateUpsertPushNotificationSubscriptionDto(
  body: unknown
): UpsertPushNotificationSubscriptionDto {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw CustomError.badRequest("El body debe ser un objeto");
  }

  const parsedBody = body as Record<string, unknown>;

  const deviceIdRaw = parsedBody.deviceId;
  if (typeof deviceIdRaw !== "string" || deviceIdRaw.trim() === "") {
    throw CustomError.badRequest("deviceId es requerido y debe ser un texto no vacío");
  }
  const deviceId = deviceIdRaw.trim();

  const tokenRaw = parsedBody.token;
  if (typeof tokenRaw !== "string" || tokenRaw.trim() === "") {
    throw CustomError.badRequest("token es requerido y debe ser un texto no vacío");
  }
  const token = tokenRaw.trim();

  const platformRaw = parsedBody.platform;
  if (typeof platformRaw !== "string" || platformRaw.trim() === "") {
    throw CustomError.badRequest("platform es requerido y debe ser un texto no vacío");
  }
  const platform = normalizeSpaces(platformRaw);

  const permissionRaw = parsedBody.notificationPermission;
  if (permissionRaw !== "granted") {
    throw CustomError.badRequest(
      "notificationPermission debe ser exactamente 'granted'"
    );
  }

  const userAgentRaw = parsedBody.userAgent;
  const userAgent =
    typeof userAgentRaw === "string" && userAgentRaw.trim() !== ""
      ? userAgentRaw.trim()
      : undefined;

  const languageRaw = parsedBody.language;
  const language =
    typeof languageRaw === "string" && languageRaw.trim() !== ""
      ? languageRaw.trim()
      : undefined;

  return {
    deviceId,
    token,
    platform,
    notificationPermission: "granted",
    ...(userAgent !== undefined && { userAgent }),
    ...(language !== undefined && { language }),
  };
}

export function validatePushNotificationDeviceIdParam(deviceId: unknown): string {
  if (typeof deviceId !== "string" || deviceId.trim() === "") {
    throw CustomError.badRequest(
      "El parámetro deviceId es requerido y debe ser un texto no vacío"
    );
  }

  return deviceId.trim();
}
