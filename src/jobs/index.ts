import cron from "node-cron";
import type { Job } from "./types";
import * as refreshAuth from "./refresh-auth";

const jobs: Job[] = [{ config: refreshAuth.config, run: refreshAuth.default }];

export function startJobs(): void {
  for (const { config, run } of jobs) {
    cron.schedule(config.schedule, run, {
      name: config.name,
      noOverlap: true,
    });
    console.log(`[jobs] ${config.name} scheduled "${config.schedule}"`);
  }
}
