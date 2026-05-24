export function parsePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] + "==", "base64url").toString());
}
