import { CustomError } from "../../domain/errors/custom-error";
import type {
  SendWhatsAppMessageResult,
  SendWhatsAppTemplateMessagePayload,
  WhatsAppMessageProvider,
} from "../../domain/interfaces/whatsapp.interface";

export interface InfobipWhatsAppApiConfig {
  baseUrl: string;
  apiKey: string;
  sender: string;
  timeoutMs: number;
}

interface InfobipRequestError {
  serviceException?: {
    messageId?: string;
    text?: string;
  };
}

interface InfobipMessageStatus {
  groupId?: number;
  groupName?: string;
  id?: number;
  name?: string;
  description?: string;
}

interface InfobipMessageResponse {
  to?: string;
  messageId?: string;
  status?: InfobipMessageStatus;
}

interface InfobipSendResponse {
  to?: string;
  messageCount?: number;
  messageId?: string;
  status?: InfobipMessageStatus;
  messages?: InfobipMessageResponse[];
  requestError?: InfobipRequestError;
  [key: string]: unknown;
}

interface InfobipTemplateMessageRequest {
  from: string;
  to: string;
  content: {
    templateName: string;
    language: string;
    templateData?: {
      header?: {
        type: "TEXT";
        placeholder: string;
      };
      body?: {
        placeholders: string[];
      };
      buttons?: Array<{
        type: "URL";
        parameter: string;
      }>;
    };
  };
}

export class InfobipWhatsAppApiClient implements WhatsAppMessageProvider {
  constructor(private readonly config: InfobipWhatsAppApiConfig) {}

  async sendTemplateMessage(
    payload: SendWhatsAppTemplateMessagePayload
  ): Promise<SendWhatsAppMessageResult> {
    this.ensureConfigured();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const templateData = this.buildTemplateData(payload);

    const messageRequest: InfobipTemplateMessageRequest = {
      from: this.config.sender.trim(),
      to: payload.to,
      content: {
        templateName: payload.templateName,
        language: payload.language,
        ...(templateData != null && {
          templateData,
        }),
      },
    };

    const requestBody = {
      messages: [messageRequest],
    };

    try {
      const response = await fetch(this.buildTemplateSendUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.buildAuthorizationHeader(),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const responseBody = (await this.parseResponseJson(response)) as InfobipSendResponse;

      if (!response.ok) {
        throw CustomError.internalServerError(
          `Infobip rechazó el envío. status=${response.status}. detalle=${this.extractProviderError(
            responseBody
          )}. request=${this.buildRequestContext(messageRequest)}. body=${JSON.stringify(responseBody)}`
        );
      }

      const message = this.extractPrimaryMessage(responseBody);
      const messageId =
        typeof message.messageId === "string" && message.messageId.trim() !== ""
          ? message.messageId.trim()
          : "";

      if (messageId === "") {
        throw CustomError.internalServerError(
          `Infobip respondió sin messageId. request=${this.buildRequestContext(
            messageRequest
          )}. body=${JSON.stringify(responseBody)}`
        );
      }

      const statusName = message.status?.groupName?.toUpperCase() ?? "";
      if (statusName === "REJECTED" || statusName === "UNDELIVERABLE") {
        throw CustomError.internalServerError(
          `Infobip devolvió un estado de rechazo. detalle=${this.extractProviderError(
            responseBody
          )}. request=${this.buildRequestContext(messageRequest)}. body=${JSON.stringify(responseBody)}`,
          "INFOBIP_MESSAGE_REJECTED"
        );
      }

      return {
        to: payload.to,
        messageId,
        provider: "INFOBIP_WHATSAPP",
        raw: responseBody,
      };
    } catch (error) {
      if (error instanceof CustomError) throw error;

      if (error instanceof Error && error.name === "AbortError") {
        throw CustomError.internalServerError(
          "Tiempo de espera agotado al enviar mensaje por Infobip"
        );
      }

      if (error instanceof TypeError) {
        throw CustomError.internalServerError(
          `No se pudo conectar con Infobip. Verifica INFOBIP_BASE_URL/red. detalle=${error.message}`
        );
      }

      if (error instanceof Error) {
        throw CustomError.internalServerError(
          `No se pudo enviar el mensaje por WhatsApp. detalle=${error.message}`
        );
      }

      throw CustomError.internalServerError(
        `No se pudo enviar el mensaje por WhatsApp. detalle=${String(error)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildTemplateSendUrl(): string {
    const base = this.config.baseUrl.trim().replace(/\/+$/, "");
    return `${base}/whatsapp/1/message/template`;
  }

  private buildAuthorizationHeader(): string {
    const token = this.config.apiKey.trim();
    if (token === "") return "";

    if (token.startsWith("App ") || token.startsWith("Bearer ")) {
      return token;
    }

    return `App ${token}`;
  }

  private async parseResponseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  private extractPrimaryMessage(body: InfobipSendResponse): InfobipMessageResponse {
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      return body.messages[0] ?? {};
    }

    const fallback: InfobipMessageResponse = {};
    if (typeof body.to === "string") fallback.to = body.to;
    if (typeof body.messageId === "string") fallback.messageId = body.messageId;
    if (body.status != null) fallback.status = body.status;
    return fallback;
  }

  private extractProviderError(body: InfobipSendResponse): string {
    const requestErrorText = body.requestError?.serviceException?.text?.trim();
    const requestErrorId = body.requestError?.serviceException?.messageId?.trim();

    if (requestErrorText != null && requestErrorText !== "") {
      return `messageId=${requestErrorId ?? "unknown"}, text=${requestErrorText}`;
    }

    const message = this.extractPrimaryMessage(body);
    const status = message.status;
    if (status != null) {
      return `status=${status.groupName ?? "unknown"}/${status.name ?? "unknown"}, description=${status.description ?? "sin descripción"}`;
    }

    return JSON.stringify(body);
  }

  private buildRequestContext(message: InfobipTemplateMessageRequest): string {
    const headerPlaceholder = message.content.templateData?.header?.placeholder;
    const bodyPlaceholders = message.content.templateData?.body?.placeholders ?? [];
    const buttons = message.content.templateData?.buttons ?? [];

    return JSON.stringify({
      to: message.to,
      from: message.from,
      templateName: message.content.templateName,
      language: message.content.language,
      headerPlaceholdersCount: headerPlaceholder != null ? 1 : 0,
      bodyPlaceholdersCount: bodyPlaceholders.length,
      buttonsCount: buttons.length,
      hasTemplateData: message.content.templateData != null,
    });
  }

  private buildTemplateData(
    payload: SendWhatsAppTemplateMessagePayload
  ): InfobipTemplateMessageRequest["content"]["templateData"] | undefined {
    const headerPlaceholders = payload.headerPlaceholders ?? [];
    const bodyPlaceholders = payload.bodyPlaceholders ?? payload.placeholders ?? [];
    const buttons = payload.buttons ?? [];

    if (
      headerPlaceholders.length === 0 &&
      bodyPlaceholders.length === 0 &&
      buttons.length === 0
    ) {
      return undefined;
    }

    return {
      ...(headerPlaceholders.length > 0 && {
        header: {
          type: "TEXT" as const,
          placeholder: headerPlaceholders[0]!,
        },
      }),
      ...(bodyPlaceholders.length > 0 && {
        body: {
          placeholders: bodyPlaceholders,
        },
      }),
      ...(buttons.length > 0 && {
        buttons,
      }),
    };
  }

  private ensureConfigured(): void {
    const missing: string[] = [];

    if (this.isUnset(this.config.baseUrl)) missing.push("INFOBIP_BASE_URL");
    if (this.isUnset(this.config.apiKey)) missing.push("INFOBIP_API_KEY");
    if (this.isUnset(this.config.sender)) missing.push("INFOBIP_WHATSAPP_SENDER");
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      missing.push("INFOBIP_TIMEOUT_MS");
    }

    if (missing.length > 0) {
      throw CustomError.internalServerError(
        `Configuración incompleta de Infobip: ${missing.join(", ")}`
      );
    }
  }

  private isUnset(value: string): boolean {
    const normalized = value.trim();
    return (
      normalized === "" ||
      normalized.toUpperCase().includes("REPLACE_ME") ||
      normalized.includes("<") ||
      normalized.includes(">")
    );
  }
}
