import { getAuth } from "../services/auth.service";
import type { JobConfig } from "./types";

const PROACTIVE_BUFFER_MS = 30 * 60 * 1000;

export const config: JobConfig = {
  name: "refresh-auth",
  schedule: "*/5 * * * *",
};

export default async function run(): Promise<void> {
  try {
    await getAuth(PROACTIVE_BUFFER_MS);
  } catch {}
}
