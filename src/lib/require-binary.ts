import fs from "node:fs"
import path from "node:path"

// Shared by agy-openai-proxy, claude-ai-proxy and codex-openai-proxy; keep byte-identical.

export class MissingBinaryError extends Error {
  constructor(
    readonly binary: string,
    install: string,
  ) {
    super(`'${binary}' is required for this command but was not found on PATH. Install it first: ${install}`)
    this.name = "MissingBinaryError"
  }
}

export function findBinary(binary: string, searchPath = process.env.PATH ?? ""): string | undefined {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""]
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = path.join(dir, binary + extension)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // Not here; keep searching.
      }
    }
  }
  return undefined
}

// Aborts before any login side effect when the official client is missing.
export function requireBinary(binary: string, install: string): string {
  const found = findBinary(binary)
  if (!found) throw new MissingBinaryError(binary, install)
  return found
}
