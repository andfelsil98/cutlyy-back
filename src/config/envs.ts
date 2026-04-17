// Asegura que las variables de entorno definidas en tu archivo .env se carguen en process.env antes de que el resto del código las intente utilizar
import "dotenv/config";
import env from "env-var";

export const envs = {
  PORT: env.get("PORT").required().asPortNumber(),
  FIREBASE_CREDENTIALS_PATH: env.get("FIREBASE_CREDENTIALS_PATH").required().asString(),
  ENV: env.get("ENV").required().asString(),
  INFOBIP_BASE_URL: env
    .get("INFOBIP_BASE_URL")
    .default("https://REPLACE_ME.api.infobip.com")
    .asString(),
  INFOBIP_API_KEY: env
    .get("INFOBIP_API_KEY")
    .default("REPLACE_ME_API_KEY")
    .asString(),
  INFOBIP_WHATSAPP_SENDER: env
    .get("INFOBIP_WHATSAPP_SENDER")
    .default("REPLACE_ME_WHATSAPP_SENDER")
    .asString(),
  INFOBIP_TIMEOUT_MS: env
    .get("INFOBIP_TIMEOUT_MS")
    .default("10000")
    .asInt(),
  CLOUD_TASKS_PROJECT_ID: env
    .get("CLOUD_TASKS_PROJECT_ID")
    .default("REPLACE_ME_PROJECT_ID")
    .asString(),
  CLOUD_TASKS_LOCATION: env
    .get("CLOUD_TASKS_LOCATION")
    .default("us-central1")
    .asString(),
  CLOUD_TASKS_QUEUE: env
    .get("CLOUD_TASKS_QUEUE")
    .default("REPLACE_ME_QUEUE")
    .asString(),
  CLOUD_TASKS_MAX_ATTEMPTS: env
    .get("CLOUD_TASKS_MAX_ATTEMPTS")
    .default("5")
    .asInt(),
  CLOUD_TASKS_TARGET_BASE_URL: env
    .get("CLOUD_TASKS_TARGET_BASE_URL")
    .default("http://localhost:3001")
    .asString(),
  CLOUD_TASKS_INTERNAL_TOKEN: env
    .get("CLOUD_TASKS_INTERNAL_TOKEN")
    .default("REPLACE_ME_INTERNAL_TASK_TOKEN")
    .asString(),
  OUTBOX_PROCESSOR_ENABLED: env
    .get("OUTBOX_PROCESSOR_ENABLED")
    .default("true")
    .asBool(),
  OUTBOX_PROCESSOR_INTERVAL_MS: env
    .get("OUTBOX_PROCESSOR_INTERVAL_MS")
    .default("15000")
    .asInt(),
  OUTBOX_PROCESSOR_BATCH_SIZE: env
    .get("OUTBOX_PROCESSOR_BATCH_SIZE")
    .default("20")
    .asInt(),
  OUTBOX_PROCESSOR_PROCESSING_TIMEOUT_SECONDS: env
    .get("OUTBOX_PROCESSOR_PROCESSING_TIMEOUT_SECONDS")
    .default("300")
    .asInt(),
  OUTBOX_PROCESSOR_RETRY_BASE_DELAY_SECONDS: env
    .get("OUTBOX_PROCESSOR_RETRY_BASE_DELAY_SECONDS")
    .default("15")
    .asInt(),
  OUTBOX_PROCESSOR_RETRY_MAX_DELAY_SECONDS: env
    .get("OUTBOX_PROCESSOR_RETRY_MAX_DELAY_SECONDS")
    .default("900")
    .asInt(),
  FRONTEND_APP_BASE_URL: env
    .get("FRONTEND_APP_BASE_URL")
    .default("http://localhost:5173")
    .asString(),
  PUSH_NOTIFICATIONS_ENABLED: env
    .get("PUSH_NOTIFICATIONS_ENABLED")
    .default("true")
    .asBool(),
};
