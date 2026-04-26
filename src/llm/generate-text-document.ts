import { createUnsupportedFunctionalityError } from "./errors.js";
import {
  isGoogleEmptySummaryError,
  resolveGoogleEmptyResponseFallbackModelId,
} from "./generate-text-shared.js";
import type { LlmProvider } from "./model-id.js";
import type { ModelRequestOptions } from "./model-options.js";
import type { Prompt } from "./prompt.js";
import {
  resolveOpenAiCompatibleClientConfigForProvider,
  supportsDocumentAttachments,
} from "./provider-capabilities.js";
import {
  completeAnthropicDocument,
  normalizeAnthropicModelAccessError,
} from "./providers/anthropic.js";
import { completeGoogleDocument } from "./providers/google.js";
import { completeOpenAiDocument } from "./providers/openai.js";
import type { LlmTokenUsage } from "./types.js";

type ParsedModel = {
  provider: LlmProvider;
  model: string;
  canonical: string;
};

type DocumentResult = {
  text: string;
  canonicalModelId: string;
  provider: ParsedModel["provider"];
  usage: LlmTokenUsage | null;
};

export async function maybeGenerateDocumentText(options: {
  parsed: ParsedModel;
  apiKeys: {
    openaiApiKey: string | null;
    googleApiKey: string | null;
    anthropicApiKey: string | null;
    openrouterApiKey: string | null;
  };
  prompt: Prompt;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  anthropicBaseUrlOverride?: string | null;
  googleBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
  retryWithModelId: (modelId: string) => Promise<DocumentResult>;
}): Promise<DocumentResult | null> {
  const {
    parsed,
    apiKeys,
    prompt,
    maxOutputTokens,
    temperature,
    timeoutMs,
    fetchImpl,
    forceOpenRouter,
    openaiBaseUrlOverride,
    anthropicBaseUrlOverride,
    googleBaseUrlOverride,
    forceChatCompletions,
    requestOptions,
    retryWithModelId,
  } = options;
  const attachments = prompt.attachments ?? [];
  const documentAttachment =
    attachments.find((attachment) => attachment.kind === "document") ?? null;
  if (!documentAttachment) return null;
  if (attachments.length !== 1) {
    throw new Error("Internal error: document attachments cannot be combined with other inputs.");
  }
  if (!supportsDocumentAttachments(parsed.provider)) {
    throw createUnsupportedFunctionalityError(
      `document attachments are not supported for ${parsed.provider}/... models`,
    );
  }

  if (parsed.provider === "anthropic") {
    const apiKey = apiKeys.anthropicApiKey;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY for anthropic/... model");
    try {
      const result = await completeAnthropicDocument({
        modelId: parsed.model,
        apiKey,
        promptText: prompt.userText,
        document: documentAttachment,
        system: prompt.system,
        maxOutputTokens,
        timeoutMs,
        fetchImpl,
        anthropicBaseUrlOverride,
      });
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.usage,
      };
    } catch (error) {
      const normalized = normalizeAnthropicModelAccessError(error, parsed.model);
      if (normalized) throw normalized;
      throw error;
    }
  }

  if (parsed.provider === "openai") {
    const openaiConfig = resolveOpenAiCompatibleClientConfigForProvider({
      provider: "openai",
      openaiApiKey: apiKeys.openaiApiKey,
      openrouterApiKey: apiKeys.openrouterApiKey,
      forceOpenRouter,
      openaiBaseUrlOverride,
      forceChatCompletions,
      requestOptions,
    });
    const result = await completeOpenAiDocument({
      modelId: parsed.model,
      openaiConfig,
      promptText: prompt.userText,
      document: documentAttachment,
      maxOutputTokens,
      temperature,
      timeoutMs,
      fetchImpl,
    });
    return {
      text: result.text,
      canonicalModelId: parsed.canonical,
      provider: parsed.provider,
      usage: result.usage,
    };
  }

  if (parsed.provider === "google") {
    const apiKey = apiKeys.googleApiKey;
    if (!apiKey) {
      throw new Error(
        "Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model",
      );
    }
    try {
      const result = await completeGoogleDocument({
        modelId: parsed.model,
        apiKey,
        promptText: prompt.userText,
        document: documentAttachment,
        maxOutputTokens,
        temperature,
        timeoutMs,
        fetchImpl,
        googleBaseUrlOverride,
      });
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.usage,
      };
    } catch (error) {
      const fallbackModelId =
        isGoogleEmptySummaryError(error) &&
        resolveGoogleEmptyResponseFallbackModelId(parsed.canonical);
      if (!fallbackModelId) throw error;
      return retryWithModelId(fallbackModelId);
    }
  }

  return null;
}
