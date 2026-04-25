import {
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateType,
} from "../../config/whatsapp-templates.config";
import { CustomError } from "../../domain/errors/custom-error";
import type {
  SendWhatsAppMessageResult,
  WhatsAppMessageProvider,
} from "../../domain/interfaces/whatsapp.interface";

export interface SendWhatsAppTemplateByTypeParams {
  to: string;
  templateType: WhatsAppTemplateType;
  placeholders?: string[];
  headerPlaceholders?: string[];
  bodyPlaceholders?: string[];
  buttons?: Array<{
    type: "URL";
    parameter: string;
  }>;
}

export class WhatsAppService {
  constructor(private readonly provider: WhatsAppMessageProvider) {}

  async sendTemplateMessage(
    params: SendWhatsAppTemplateByTypeParams
  ): Promise<SendWhatsAppMessageResult> {
    const normalizedTo = this.normalizeTo(params.to);
    const template = WHATSAPP_TEMPLATES[params.templateType];

    const templateName = template.templateName.trim();
    const language = template.language.trim();

    if (templateName === "") {
      throw CustomError.internalServerError(
        "Configuración inválida de plantilla de WhatsApp"
      );
    }

    if (language === "") {
      throw CustomError.internalServerError(
        "Configuración inválida de plantilla de WhatsApp"
      );
    }

    const resolvedBodyPlaceholders =
      params.bodyPlaceholders ?? params.placeholders ?? template.defaultPlaceholders;

    return this.provider.sendTemplateMessage({
      to: normalizedTo,
      templateName,
      language,
      ...(params.headerPlaceholders != null && params.headerPlaceholders.length > 0 && {
        headerPlaceholders: params.headerPlaceholders,
      }),
      ...(resolvedBodyPlaceholders != null && resolvedBodyPlaceholders.length > 0 && {
        bodyPlaceholders: resolvedBodyPlaceholders,
      }),
      ...(params.buttons != null && params.buttons.length > 0 && {
        buttons: params.buttons,
      }),
    });
  }

  private normalizeTo(to: string): string {
    const normalized = to.replace(/\s+/g, "").replace(/^\+/, "");
    const phoneRegex = /^[1-9]\d{7,14}$/;

    if (!phoneRegex.test(normalized)) {
      throw CustomError.badRequest(
        "to debe ser un número válido en formato internacional (ej: 573001234567)"
      );
    }

    return normalized;
  }
}
