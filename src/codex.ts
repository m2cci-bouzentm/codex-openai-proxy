import os from "os";
import { getAuth, type AuthResult } from "./auth";

const CODEX_API = "https://chatgpt.com/backend-api/codex/responses";
const USER_AGENT = `codex-proxy/1.0.0 (${process.platform} ${os.release()}; ${process.arch})`;

function buildHeaders(auth: AuthResult, sessionId: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": USER_AGENT,
    "originator": "opencode",
    "session_id": sessionId,
  };
}

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

function convertMessages(messages: Message[]): { instructions: string; input: Message[] } {
  const input: Message[] = [];
  let instructions = "You are a helpful assistant.";

  for (const m of messages) {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        : "";

    if (m.role === "system") {
      instructions = text;
    } else {
      input.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
    }
  }

  return { instructions, input };
}

function parseSSE(body: string): string {
  let content = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === "response.output_text.delta") content += evt.delta || "";
    } catch {}
  }
  return content;
}

export async function createCompletion(messages: Message[], model: string): Promise<string> {
  const auth = await getAuth();
  const { instructions, input } = convertMessages(messages);

  const resp = await fetch(CODEX_API, {
    method: "POST",
    headers: buildHeaders(auth, crypto.randomUUID()),
    body: JSON.stringify({ model, instructions, input, stream: true, store: false }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Codex API ${resp.status}: ${body}`);
  }

  return parseSSE(await resp.text());
}
