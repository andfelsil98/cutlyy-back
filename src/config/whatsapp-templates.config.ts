export const WHATSAPP_TEMPLATE_TYPES = [
  "APPOINTMENT_CONFIRMATION",
  "APPOINTMENT_MODIFICATION",
  "APPOINTMENT_COMPLETION",
] as const;

export type WhatsAppTemplateType = (typeof WHATSAPP_TEMPLATE_TYPES)[number];

export interface WhatsAppTemplateConfig {
  templateName: string;
  language: string;
  defaultPlaceholders?: string[];
}

export const WHATSAPP_TEMPLATES: Record<WhatsAppTemplateType, WhatsAppTemplateConfig> = {
  APPOINTMENT_CONFIRMATION: {
    templateName: "book_confirmation",
    language: "es_CO",
  },
  APPOINTMENT_MODIFICATION: {
    templateName: "book_cancellation",
    language: "es_CO",
  },
  APPOINTMENT_COMPLETION: {
    templateName: "book_finished",
    language: "es_CO",
  },
};
