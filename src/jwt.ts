export function parsePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] + "==", "base64url").toString());
}

function extractFromClaims(claims: Record<string, unknown>): string | undefined {
  const oa = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return (oa?.chatgpt_account_id as string) ?? (claims["chatgpt_account_id"] as string);
}

export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  const idResult = tokens.id_token && extractFromClaims(parsePayload(tokens.id_token));
  return idResult ?? (tokens.access_token && extractFromClaims(parsePayload(tokens.access_token))) ?? undefined;
}
