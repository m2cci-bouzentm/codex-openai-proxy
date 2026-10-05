export const MODELS = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.3-codex-spark",
] as const;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

const DEFAULT_ALIASES: Record<string, string> = {
  "gpt-5.4-mini": "gpt-5.6-luna",
  "gpt-5.4": "gpt-5.6-terra",
  "gpt-5.3-codex": "gpt-5.6-terra",
  "gpt-5.2": "gpt-5.6-sol",
};

function parseAliases(raw: string | undefined): Record<string, string> {
  const aliases = { ...DEFAULT_ALIASES };
  for (const pair of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [from, to] = pair.split("=").map((s) => s.trim());
    if (from && to) aliases[from] = to;
  }
  return aliases;
}

const ALIASES = parseAliases(process.env.MODEL_ALIASES);

export function resolveModel(requested: string): string {
  const resolved = ALIASES[requested] ?? requested;
  if (resolved !== requested) console.log(`[model] alias ${requested} -> ${resolved}`);
  return resolved;
}
