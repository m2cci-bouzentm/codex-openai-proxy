export interface JobConfig {
  name: string
  schedule: string
}

export interface Job {
  config: JobConfig
  run: () => Promise<void>
}
