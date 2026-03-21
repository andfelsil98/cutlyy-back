export interface SendWhatsAppTemplateMessagePayload {
  to: string;
  templateName: string;
  language: string;
  placeholders?: string[];
  headerPlaceholders?: string[];
  bodyPlaceholders?: string[];
  buttons?: Array<{
    type: "URL";
    parameter: string;
  }>;
}

export interface SendWhatsAppMessageResult {
  to: string;
  messageId: string;
  provider: "INFOBIP_WHATSAPP";
  raw: unknown;
}

export interface WhatsAppMessageProvider {
  sendTemplateMessage(
    payload: SendWhatsAppTemplateMessagePayload
  ): Promise<SendWhatsAppMessageResult>;
}
