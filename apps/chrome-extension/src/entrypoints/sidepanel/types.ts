import type { Message } from "@mariozechner/pi-ai";
import type { SseSlidesData } from "../../../../../src/shared/sse-events.js";
import type { RunStart, UiState } from "../../lib/panel-contracts";
export type { RunStart, UiState } from "../../lib/panel-contracts";

export type PanelPhase = "idle" | "setup" | "connecting" | "streaming" | "error";

export type ChatMessage = Message & { id: string };

export type PanelState = {
  ui: UiState | null;
  runId: string | null;
  slidesRunId: string | null;
  currentSource: { url: string; title: string | null } | null;
  lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null };
  summaryMarkdown: string | null;
  summaryFromCache: boolean | null;
  slides: SseSlidesData | null;
  phase: PanelPhase;
  error: string | null;
  chatStreaming: boolean;
};
