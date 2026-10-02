import { config } from "../config";
import type { ModelProvider } from "./adapter";

// Minimal Gemini REST client. Uses fetch directly instead of the SDK to keep
// dependencies lean; the ModelProvider interface keeps Gemini replaceable.
export class GeminiProvider implements ModelProvider {
  name = "gemini";

  async generateStructured(args: {
    system: string;
    user: string;
    images?: Array<{ mimeType: string; data: Buffer }>;
    maxOutputTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; promptTokens?: number; outputTokens?: number }> {
    const apiKey = config.gemini.apiKey;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    // Model is chosen by the caller via modelFor(); default to light here.
    const model = config.gemini.modelLight;
    return this.callModel(model, args);
  }

  async callModel(
    model: string,
    args: {
      system: string;
      user: string;
      images?: Array<{ mimeType: string; data: Buffer }>;
      maxOutputTokens?: number;
      temperature?: number;
    }
  ): Promise<{ text: string; promptTokens?: number; outputTokens?: number }> {
    const apiKey = config.gemini.apiKey;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

    const parts: Array<Record<string, unknown>> = [{ text: args.user }];
    for (const img of args.images ?? []) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.data.toString("base64"),
        },
      });
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
      `:generateContent?key=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.gemini.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: args.system }] },
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: args.maxOutputTokens ?? 4000,
            temperature: args.temperature ?? 0.2,
          },
        }),
      });
    } catch (e) {
      throw new Error(
        `Gemini request failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const err = new Error("Gemini rate limited (429)");
      (err as { retryable?: boolean }).retryable = true;
      throw err;
    }
    if (res.status >= 500) {
      const err = new Error(`Gemini server error (${res.status})`);
      (err as { retryable?: boolean }).retryable = true;
      throw err;
    }
    if (!res.ok) {
      // 4xx other than 429: not retryable (bad key, bad model, bad request).
      const body = await res.text().catch(() => "");
      throw new Error(`Gemini request rejected (${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) throw new Error("Gemini returned no content");
    return {
      text,
      promptTokens: json.usageMetadata?.promptTokenCount,
      outputTokens: json.usageMetadata?.candidatesTokenCount,
    };
  }
}

export function isRetryable(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as { retryable?: boolean }).retryable === true
  );
}
