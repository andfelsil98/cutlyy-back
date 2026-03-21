import { envs } from "../../config/envs";
import { GoogleCloudTasksQueueProvider } from "./google-cloud-tasks.client";

export function createGoogleCloudTasksQueueProvider(): GoogleCloudTasksQueueProvider {
  return new GoogleCloudTasksQueueProvider({
    projectId: envs.CLOUD_TASKS_PROJECT_ID,
    location: envs.CLOUD_TASKS_LOCATION,
    queue: envs.CLOUD_TASKS_QUEUE,
    maxAttempts: envs.CLOUD_TASKS_MAX_ATTEMPTS,
  });
}
