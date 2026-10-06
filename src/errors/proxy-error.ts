export class ProxyError extends Error {
    constructor(
        message: string,
        readonly status: number = 400,
        readonly type: string = "invalid_request_error",
        readonly retryAfter?: string,
    ) {
        super(message);
        this.name = "ProxyError";
    }
}

const PROVIDER_MESSAGE_LIMIT = 500;

export function sanitizeProviderMessage(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const printable = Array.from(value, (character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 ? " " : character;
    }).join("");
    const clean = printable
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[REDACTED]")
        .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[REDACTED]")
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
        .replace(/\s+/g, " ")
        .trim();
    if (!clean) return undefined;
    return clean.length > PROVIDER_MESSAGE_LIMIT
        ? `${clean.slice(0, PROVIDER_MESSAGE_LIMIT)}…`
        : clean;
}

// Maps a provider's non-2xx answer to the error the client receives: the
// client's own mistakes keep their status, proxy-side failures become 502.
export function upstreamRejection(
    provider: string,
    status: number,
    providerMessage?: unknown,
    retryAfter?: string | null,
): ProxyError {
    const detail = sanitizeProviderMessage(providerMessage);
    const suffix = detail ? `: ${detail}` : "";
    if (status === 429)
        return new ProxyError(
            `${provider} rate limit reached (HTTP 429)${suffix}`,
            429,
            "rate_limit_error",
            retryAfter ?? undefined,
        );
    if (status === 401 || status === 403)
        return new ProxyError(
            `${provider} rejected the proxy credentials (HTTP ${status})${suffix}`,
            502,
            "upstream_error",
        );
    if (status === 404)
        return new ProxyError(`${provider} rejected request (HTTP 404)${suffix}`, 404, "not_found_error");
    if (status === 413)
        return new ProxyError(`${provider} rejected request (HTTP 413)${suffix}`, 413);
    if (status >= 400 && status < 500)
        return new ProxyError(`${provider} rejected request (HTTP ${status})${suffix}`, 400);
    return new ProxyError(`${provider} upstream failed (HTTP ${status})${suffix}`, 502, "upstream_error");
}

// Reads only the provider's structured `error.message` from at most 64 KiB;
// raw bodies never leak.
export async function readProviderMessage(response: Response): Promise<string | undefined> {
    const limit = 64 * 1024;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        const reader = response.body?.getReader();
        while (reader && size < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.byteLength;
        }
        await reader?.cancel().catch(() => undefined);
        return providerMessage(Buffer.concat(chunks).subarray(0, limit).toString("utf8"));
    } catch {
        return undefined;
    }
}

export function providerMessage(body: string): string | undefined {
    try {
        const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown };
        if (typeof parsed.error === "string") return parsed.error;
        if (typeof parsed.error?.message === "string") return parsed.error.message;
        return typeof parsed.detail === "string" ? parsed.detail : undefined;
    } catch {
        return undefined;
    }
}
