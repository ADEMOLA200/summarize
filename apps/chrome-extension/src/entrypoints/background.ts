import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import { defineBackground } from "wxt/utils/define-background";
import type { SseSlidesData } from "../../../../src/shared/sse-events.js";
import { readAgentResponse } from "../lib/agent-response";
import { buildChatPageContent } from "../lib/chat-context";
import { buildDaemonRequestBody, buildSummarizeRequestBody } from "../lib/daemon-payload";
import { createDaemonRecovery, isDaemonUnreachableError } from "../lib/daemon-recovery";
import { createDaemonStatusTracker } from "../lib/daemon-status";
import { logExtensionEvent } from "../lib/extension-logs";
import { loadSettings, patchSettings } from "../lib/settings";
import { isYouTubeWatchUrl } from "../lib/youtube-url";
import {
  canSummarizeUrl,
  extractFromTab,
  seekInTab,
  type ExtractResponse,
} from "./background/content-script-bridge";
import { daemonHealth, daemonPing, friendlyFetchError } from "./background/daemon-client";
import { ensureChatExtract, primeMediaHint, type CachedExtract } from "./background/extract-cache";
import { createHoverController, type HoverToBg } from "./background/hover-controller";
import { createPanelSessionStore, type PanelSession } from "./background/panel-session-store";
import { resolvePanelState, type PanelUiState } from "./background/panel-state";
import {
  buildSlidesText,
  getActiveTab,
  openOptionsWindow,
  type SlidesPayload,
  urlsMatch,
} from "./background/panel-utils";
import {
  createRuntimeActionsHandler,
  type ArtifactsRequest,
  type NativeInputRequest,
} from "./background/runtime-actions";

type PanelToBg =
  | { type: "panel:ready" }
  | { type: "panel:summarize"; refresh?: boolean; inputMode?: "page" | "video" }
  | {
      type: "panel:agent";
      requestId: string;
      messages: Message[];
      tools: string[];
      summary?: string | null;
    }
  | {
      type: "panel:chat-history";
      requestId: string;
      summary?: string | null;
    }
  | { type: "panel:seek"; seconds: number }
  | { type: "panel:ping" }
  | { type: "panel:closed" }
  | { type: "panel:rememberUrl"; url: string }
  | { type: "panel:setAuto"; value: boolean }
  | { type: "panel:setLength"; value: string }
  | { type: "panel:slides-context"; requestId: string; url?: string }
  | { type: "panel:cache"; cache: PanelCachePayload }
  | { type: "panel:get-cache"; requestId: string; tabId: number; url: string }
  | { type: "panel:openOptions" };

type RunStart = {
  id: string;
  url: string;
  title: string | null;
  model: string;
  reason: string;
};

type BgToPanel =
  | { type: "ui:state"; state: PanelUiState }
  | { type: "ui:status"; status: string }
  | { type: "run:start"; run: RunStart }
  | { type: "run:error"; message: string }
  | { type: "slides:run"; ok: boolean; runId?: string; url?: string; error?: string }
  | { type: "agent:chunk"; requestId: string; text: string }
  | { type: "chat:history"; requestId: string; ok: boolean; messages?: Message[]; error?: string }
  | {
      type: "agent:response";
      requestId: string;
      ok: boolean;
      assistant?: AssistantMessage;
      error?: string;
    }
  | {
      type: "slides:context";
      requestId: string;
      ok: boolean;
      transcriptTimedText?: string | null;
      error?: string;
    }
  | { type: "ui:cache"; requestId: string; ok: boolean; cache?: PanelCachePayload };

type PanelCachePayload = {
  tabId: number;
  url: string;
  title: string | null;
  runId: string | null;
  slidesRunId: string | null;
  summaryMarkdown: string | null;
  summaryFromCache: boolean | null;
  slidesSummaryMarkdown: string | null;
  slidesSummaryComplete: boolean | null;
  slidesSummaryModel: string | null;
  lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null };
  slides: SseSlidesData | null;
  transcriptTimedText: string | null;
};

type BackgroundPanelSession = PanelSession<
  ReturnType<typeof createDaemonRecovery>,
  ReturnType<typeof createDaemonStatusTracker>
>;
export default defineBackground(() => {
  const panelSessionStore = createPanelSessionStore<
    CachedExtract,
    PanelCachePayload,
    ReturnType<typeof createDaemonRecovery>,
    ReturnType<typeof createDaemonStatusTracker>
  >({
    createDaemonRecovery,
    createDaemonStatus: createDaemonStatusTracker,
  });
  const hoverControllersByTabId = new Map<
    number,
    { requestId: string; controller: AbortController }
  >();
  // Tabs explicitly armed by the sidepanel for debugger-driven native input.
  // Prevents arbitrary pages from triggering trusted clicks via the
  // postMessage → content-script → runtime bridge.
  const nativeInputArmedTabs = new Set<number>();

  function resolveLogLevel(event: string) {
    const normalized = event.toLowerCase();
    if (normalized.includes("error") || normalized.includes("failed")) return "error";
    if (normalized.includes("warn")) return "warn";
    return "verbose";
  }
  const runtimeActionsHandler = createRuntimeActionsHandler({
    armedTabs: nativeInputArmedTabs,
  });
  const hoverController = createHoverController({
    hoverControllersByTabId,
    buildDaemonRequestBody,
    resolveLogLevel,
  });

  const send = (session: BackgroundPanelSession, msg: BgToPanel) => {
    if (!panelSessionStore.isPanelOpen(session)) return;
    try {
      session.port.postMessage(msg);
    } catch {
      // ignore (panel closed / reloading)
    }
  };
  const sendStatus = (session: BackgroundPanelSession, status: string) =>
    void send(session, { type: "ui:status", status });

  const emitState = async (
    session: BackgroundPanelSession,
    status: string,
    opts?: { checkRecovery?: boolean },
  ) => {
    const next = await resolvePanelState({
      session,
      status,
      checkRecovery: opts?.checkRecovery,
      loadSettings,
      getActiveTab,
      daemonHealth,
      daemonPing,
      panelSessionStore,
      urlsMatch,
      canSummarizeUrl,
    });
    void send(session, { type: "ui:state", state: next.state });

    if (next.shouldRecover) {
      void summarizeActiveTab(session, "daemon-recovered");
      return;
    }

    if (next.shouldClearPending) {
      session.daemonRecovery.clearPending();
    }

    if (next.shouldPrimeMedia) {
      void primeMediaHint({
        session,
        ...next.shouldPrimeMedia,
        panelSessionStore,
        urlsMatch,
        extractFromTab,
        emitState: (currentSession, status) => {
          void emitState(currentSession as BackgroundPanelSession, status);
        },
      });
    }
  };

  const summarizeActiveTab = async (
    session: BackgroundPanelSession,
    reason: string,
    opts?: { refresh?: boolean; inputMode?: "page" | "video" },
  ) => {
    if (!panelSessionStore.isPanelOpen(session)) return;

    const settings = await loadSettings();
    const isManual = reason === "manual" || reason === "refresh" || reason === "length-change";
    if (!isManual && !settings.autoSummarize) return;
    if (!settings.token.trim()) {
      await emitState(session, "Setup required (missing token)");
      return;
    }

    const logPanel = (event: string, detail?: Record<string, unknown>) => {
      if (!settings.extendedLogging) return;
      const payload = detail ? { event, windowId: session.windowId, ...detail } : { event };
      const detailPayload = detail
        ? { windowId: session.windowId, ...detail }
        : { windowId: session.windowId };
      logExtensionEvent({
        event,
        detail: detailPayload,
        scope: "panel:bg",
        level: resolveLogLevel(event),
      });
      console.debug("[summarize][panel:bg]", payload);
    };

    if (reason === "spa-nav" || reason === "tab-url-change") {
      await new Promise((resolve) => setTimeout(resolve, 220));
    }

    const tab = await getActiveTab(session.windowId);
    if (!tab?.id || !canSummarizeUrl(tab.url)) return;

    session.runController?.abort();
    const controller = new AbortController();
    session.runController = controller;

    const prefersUrlMode = Boolean(tab.url && shouldPreferUrlMode(tab.url));
    const wantsUrlFastPath =
      Boolean(tab.url && isYouTubeWatchUrl(tab.url)) &&
      opts?.inputMode !== "page" &&
      prefersUrlMode;

    let extracted: ExtractResponse & { ok: true };
    if (wantsUrlFastPath) {
      sendStatus(session, `Fetching transcript… (${reason})`);
      logPanel("extract:url-fastpath:start", { reason, tabId: tab.id });
      try {
        const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.token.trim()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            url: tab.url,
            title: tab.title ?? null,
            mode: "url",
            extractOnly: true,
            timestamps: true,
            ...(opts?.refresh ? { noCache: true } : {}),
            maxCharacters: null,
            diagnostics: settings.extendedLogging ? { includeContent: true } : null,
          }),
          signal: controller.signal,
        });
        const json = (await res.json()) as {
          ok?: boolean;
          extracted?: {
            url: string;
            title: string | null;
            content: string;
            truncated: boolean;
            mediaDurationSeconds?: number | null;
            transcriptTimedText?: string | null;
          };
          error?: string;
        };
        if (!res.ok || !json.ok || !json.extracted) {
          throw new Error(json.error || `${res.status} ${res.statusText}`);
        }
        const extractedUrl = json.extracted.url || tab.url;
        extracted = {
          ok: true,
          url: extractedUrl,
          title: json.extracted.title ?? tab.title ?? null,
          text: "",
          truncated: Boolean(json.extracted.truncated),
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
          mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
        };
        panelSessionStore.setCachedExtract(tab.id, {
          url: extractedUrl,
          title: extracted.title ?? null,
          text: "",
          source: "url",
          truncated: Boolean(json.extracted.truncated),
          totalCharacters: 0,
          wordCount: null,
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
          transcriptSource: null,
          transcriptionProvider: null,
          transcriptCharacters: null,
          transcriptWordCount: null,
          transcriptLines: null,
          transcriptTimedText: json.extracted.transcriptTimedText ?? null,
          mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
          slides: null,
          diagnostics: null,
        });
        session.daemonStatus.markReady();
        logPanel("extract:url-fastpath:ok", {
          url: extractedUrl,
          transcriptTimedText: Boolean(json.extracted.transcriptTimedText),
          durationSeconds: json.extracted.mediaDurationSeconds ?? null,
        });
      } catch (err) {
        logPanel("extract:url-fastpath:error", {
          error: err instanceof Error ? err.message : String(err),
        });
        extracted = {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: "",
          truncated: false,
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        };
      }
    } else {
      sendStatus(session, `Extracting… (${reason})`);
      logPanel("extract:start", { reason, tabId: tab.id, maxChars: settings.maxChars });
      const statusFromExtractEvent = (event: string) => {
        if (!panelSessionStore.isPanelOpen(session)) return;
        if (event === "extract:attempt") {
          sendStatus(session, `Extracting page content… (${reason})`);
          return;
        }
        if (event === "extract:inject:ok") {
          sendStatus(session, `Extracting: injecting… (${reason})`);
          return;
        }
        if (event === "extract:message:ok") {
          sendStatus(session, `Extracting: reading… (${reason})`);
        }
      };
      const extractedAttempt = await extractFromTab(tab.id, settings.maxChars, {
        timeoutMs: 8_000,
        log: (event, detail) => {
          statusFromExtractEvent(event);
          logPanel(event, detail);
        },
      });
      logPanel(extractedAttempt.ok ? "extract:done" : "extract:failed", {
        ok: extractedAttempt.ok,
        ...(extractedAttempt.ok
          ? { url: extractedAttempt.data.url }
          : { error: extractedAttempt.error }),
      });
      extracted = extractedAttempt.ok
        ? extractedAttempt.data
        : {
            ok: true,
            url: tab.url,
            title: tab.title ?? null,
            text: "",
            truncated: false,
            media: null,
          };
    }

    if (tab.url && extracted.url && !urlsMatch(tab.url, extracted.url)) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      logPanel("extract:retry", { tabId: tab.id, maxChars: settings.maxChars });
      const retry = await extractFromTab(tab.id, settings.maxChars, {
        timeoutMs: 8_000,
        log: (event, detail) => logPanel(event, detail),
      });
      if (retry.ok) {
        extracted = retry.data;
      }
    }

    const extractedMatchesTab = tab.url && extracted.url ? urlsMatch(tab.url, extracted.url) : true;
    const resolvedExtracted =
      tab.url && !extractedMatchesTab
        ? {
            ok: true,
            url: tab.url,
            title: tab.title ?? null,
            text: "",
            truncated: false,
            media: null,
          }
        : extracted;

    if (!extracted) return;

    if (
      settings.autoSummarize &&
      ((session.lastSummarizedUrl && urlsMatch(session.lastSummarizedUrl, resolvedExtracted.url)) ||
        (session.inflightUrl && urlsMatch(session.inflightUrl, resolvedExtracted.url))) &&
      !isManual
    ) {
      sendStatus(session, "");
      return;
    }

    const resolvedTitle = tab.title?.trim() || resolvedExtracted.title || null;
    const resolvedPayload = { ...resolvedExtracted, title: resolvedTitle };
    const effectiveInputMode =
      opts?.inputMode ??
      (resolvedPayload.url && shouldPreferUrlMode(resolvedPayload.url) ? "video" : undefined);
    const wordCount =
      resolvedPayload.text.length > 0
        ? resolvedPayload.text.split(/\s+/).filter(Boolean).length
        : 0;
    const wantsSummaryTimestamps =
      settings.summaryTimestamps &&
      (effectiveInputMode === "video" ||
        resolvedPayload.media?.hasVideo === true ||
        resolvedPayload.media?.hasAudio === true ||
        resolvedPayload.media?.hasCaptions === true ||
        shouldPreferUrlMode(resolvedPayload.url));
    const wantsSlides =
      settings.slidesEnabled &&
      (effectiveInputMode === "video" ||
        resolvedPayload.media?.hasVideo === true ||
        shouldPreferUrlMode(resolvedPayload.url));
    const wantsParallelSlides = wantsSlides && settings.slidesParallel;
    const summaryTimestamps = wantsSummaryTimestamps || (wantsSlides && !wantsParallelSlides);
    const slidesTimestamps = wantsSummaryTimestamps || wantsSlides;

    const resolveSlidesForLength = (
      lengthValue: string,
      durationSeconds: number | null | undefined,
    ): { maxSlides: number | null; minDurationSeconds: number | null } => {
      if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return { maxSlides: null, minDurationSeconds: null };
      }
      const normalized = lengthValue.trim().toLowerCase();
      const chunkSeconds =
        normalized === "short"
          ? 600
          : normalized === "medium"
            ? 450
            : normalized === "long"
              ? 300
              : normalized === "xl"
                ? 180
                : normalized === "xxl"
                  ? 120
                  : 300;
      const target = Math.max(3, Math.round(durationSeconds / chunkSeconds));
      const maxSlides = Math.max(3, Math.min(80, target));
      const minDuration = Math.max(2, Math.floor(durationSeconds / maxSlides));
      return { maxSlides, minDurationSeconds: minDuration };
    };
    logPanel("summarize:start", {
      reason,
      url: resolvedPayload.url,
      inputMode: effectiveInputMode ?? null,
      wantsSummaryTimestamps: summaryTimestamps,
      wantsSlides,
      wantsParallelSlides,
    });

    panelSessionStore.setCachedExtract(tab.id, {
      url: resolvedPayload.url,
      title: resolvedTitle,
      text: resolvedPayload.text,
      source: "page",
      truncated: resolvedPayload.truncated,
      totalCharacters: resolvedPayload.text.length,
      wordCount,
      media: resolvedPayload.media ?? null,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptCharacters: null,
      transcriptWordCount: null,
      transcriptLines: null,
      transcriptTimedText: null,
      mediaDurationSeconds: resolvedPayload.mediaDurationSeconds ?? null,
      slides: null,
      diagnostics: null,
    });

    sendStatus(session, "Connecting…");
    session.inflightUrl = resolvedPayload.url;
    const slideAuto = wantsSlides
      ? resolveSlidesForLength(settings.length, resolvedPayload.mediaDurationSeconds)
      : { maxSlides: null, minDurationSeconds: null };
    const slidesConfig = wantsSlides
      ? {
          enabled: true,
          ocr: settings.slidesOcrEnabled,
          maxSlides: slideAuto.maxSlides,
          minDurationSeconds: slideAuto.minDurationSeconds,
        }
      : { enabled: false };
    const summarySlides = wantsParallelSlides ? { enabled: false } : slidesConfig;
    let id: string;
    try {
      const body = buildSummarizeRequestBody({
        extracted: resolvedPayload,
        settings,
        noCache: Boolean(opts?.refresh),
        inputMode: effectiveInputMode,
        timestamps: summaryTimestamps,
        slides: summarySlides,
      });
      logPanel("summarize:request", {
        url: resolvedPayload.url,
        slides: wantsSlides && !wantsParallelSlides,
        slidesParallel: wantsParallelSlides,
        timestamps: summaryTimestamps,
      });
      const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.token.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (!res.ok || !json.ok || !json.id) {
        throw new Error(json.error || `${res.status} ${res.statusText}`);
      }
      session.daemonStatus.markReady();
      id = json.id;
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = friendlyFetchError(err, "Daemon request failed");
      void send(session, { type: "run:error", message });
      sendStatus(session, `Error: ${message}`);
      session.inflightUrl = null;
      if (!isManual && isDaemonUnreachableError(err)) {
        session.daemonRecovery.recordFailure(resolvedPayload.url);
      }
      return;
    }

    void send(session, {
      type: "run:start",
      run: { id, url: resolvedPayload.url, title: resolvedTitle, model: settings.model, reason },
    });

    if (wantsParallelSlides) {
      void (async () => {
        try {
          const slidesBody = buildSummarizeRequestBody({
            extracted: resolvedPayload,
            settings,
            noCache: Boolean(opts?.refresh),
            inputMode: effectiveInputMode,
            timestamps: slidesTimestamps,
            slides: slidesConfig,
          });
          logPanel("slides:request", { url: resolvedPayload.url });
          const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${settings.token.trim()}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(slidesBody),
            signal: controller.signal,
          });
          const json = (await res.json()) as { ok: boolean; id?: string; error?: string };
          if (!res.ok || !json.ok || !json.id) {
            throw new Error(json.error || `${res.status} ${res.statusText}`);
          }
          session.daemonStatus.markReady();
          if (controller.signal.aborted) return;
          if (
            session.runController !== controller ||
            (session.inflightUrl && !urlsMatch(session.inflightUrl, resolvedPayload.url))
          ) {
            return;
          }
          void send(session, {
            type: "slides:run",
            ok: true,
            runId: json.id,
            url: resolvedPayload.url,
          });
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = friendlyFetchError(err, "Slides request failed");
          if (
            session.runController !== controller ||
            (session.inflightUrl && !urlsMatch(session.inflightUrl, resolvedPayload.url))
          ) {
            return;
          }
          logPanel("slides:request:error", { error: message });
          void send(session, { type: "slides:run", ok: false, error: message });
        }
      })();
    }
  };

  const handlePanelMessage = (session: BackgroundPanelSession, raw: PanelToBg) => {
    if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") {
      return;
    }
    const type = raw.type;
    if (type !== "panel:closed") {
      session.panelOpen = true;
    }
    if (type === "panel:ping") session.panelLastPingAt = Date.now();

    switch (type) {
      case "panel:ready":
        session.panelOpen = true;
        session.panelLastPingAt = Date.now();
        session.lastSummarizedUrl = null;
        session.inflightUrl = null;
        session.runController?.abort();
        session.runController = null;
        session.agentController?.abort();
        session.agentController = null;
        session.daemonRecovery.clearPending();
        void emitState(session, "");
        void summarizeActiveTab(session, "panel-open");
        break;
      case "panel:closed":
        session.panelOpen = false;
        session.panelLastPingAt = 0;
        session.runController?.abort();
        session.runController = null;
        session.agentController?.abort();
        session.agentController = null;
        session.lastSummarizedUrl = null;
        session.inflightUrl = null;
        session.daemonRecovery.clearPending();
        void panelSessionStore.clearCachedExtractsForWindow(session.windowId);
        break;
      case "panel:summarize":
        void summarizeActiveTab(
          session,
          (raw as { refresh?: boolean }).refresh ? "refresh" : "manual",
          {
            refresh: Boolean((raw as { refresh?: boolean }).refresh),
            inputMode: (raw as { inputMode?: "page" | "video" }).inputMode,
          },
        );
        break;
      case "panel:cache": {
        const payload = (raw as { cache?: PanelCachePayload }).cache;
        if (!payload || typeof payload.tabId !== "number" || !payload.url) return;
        panelSessionStore.storePanelCache(payload);
        break;
      }
      case "panel:get-cache": {
        const payload = raw as { requestId: string; tabId: number; url: string };
        if (!payload.requestId || !payload.tabId || !payload.url) {
          return;
        }
        const cached = panelSessionStore.getPanelCache(payload.tabId, payload.url);
        void send(session, {
          type: "ui:cache",
          requestId: payload.requestId,
          ok: Boolean(cached),
          cache: cached ?? undefined,
        });
        break;
      }
      case "panel:agent":
        void (async () => {
          const settings = await loadSettings();
          if (!settings.chatEnabled) {
            void send(session, { type: "run:error", message: "Chat is disabled in settings" });
            return;
          }
          if (!settings.token.trim()) {
            void send(session, { type: "run:error", message: "Setup required (missing token)" });
            return;
          }

          const tab = await getActiveTab(session.windowId);
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, { type: "run:error", message: "Cannot chat on this page" });
            return;
          }

          let cachedExtract: CachedExtract;
          try {
            cachedExtract = await ensureChatExtract({
              session,
              tab,
              settings,
              panelSessionStore,
              sendStatus: (status) => sendStatus(session, status),
              extractFromTab,
              fetchImpl: fetch,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void send(session, { type: "run:error", message });
            sendStatus(session, `Error: ${message}`);
            return;
          }

          session.agentController?.abort();
          const agentController = new AbortController();
          session.agentController = agentController;
          const isStillActive = () =>
            session.agentController === agentController && !agentController.signal.aborted;

          const agentPayload = raw as {
            requestId: string;
            messages: Message[];
            tools: string[];
            summary?: string | null;
          };
          const summaryText =
            typeof agentPayload.summary === "string" ? agentPayload.summary.trim() : "";
          const slidesContext = buildSlidesText(cachedExtract.slides, settings.slidesOcrEnabled);
          const pageContent = buildChatPageContent({
            transcript: cachedExtract.transcriptTimedText ?? cachedExtract.text,
            summary: summaryText,
            summaryCap: settings.maxChars,
            slides: slidesContext,
            metadata: {
              url: cachedExtract.url,
              title: cachedExtract.title,
              source: cachedExtract.source,
              extractionStrategy:
                cachedExtract.source === "page"
                  ? "readability (content script)"
                  : (cachedExtract.diagnostics?.strategy ?? null),
              markdownProvider: cachedExtract.diagnostics?.markdown?.used
                ? (cachedExtract.diagnostics?.markdown?.provider ?? "unknown")
                : null,
              firecrawlUsed: cachedExtract.diagnostics?.firecrawl?.used ?? null,
              transcriptSource: cachedExtract.transcriptSource,
              transcriptionProvider: cachedExtract.transcriptionProvider,
              transcriptCache: cachedExtract.diagnostics?.transcript?.cacheStatus ?? null,
              attemptedTranscriptProviders:
                cachedExtract.diagnostics?.transcript?.attemptedProviders ?? null,
              mediaDurationSeconds: cachedExtract.mediaDurationSeconds,
              totalCharacters: cachedExtract.totalCharacters,
              wordCount: cachedExtract.wordCount,
              transcriptCharacters: cachedExtract.transcriptCharacters,
              transcriptWordCount: cachedExtract.transcriptWordCount,
              transcriptLines: cachedExtract.transcriptLines,
              transcriptHasTimestamps: Boolean(cachedExtract.transcriptTimedText),
              truncated: cachedExtract.truncated,
            },
          });
          const cacheContent = cachedExtract.transcriptTimedText ?? cachedExtract.text;

          sendStatus(session, "Sending to AI…");

          try {
            const res = await fetch("http://127.0.0.1:8787/v1/agent", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${settings.token.trim()}`,
                "content-type": "application/json",
                Accept: "text/event-stream",
              },
              body: JSON.stringify({
                url: cachedExtract.url,
                title: cachedExtract.title,
                pageContent,
                cacheContent,
                messages: agentPayload.messages,
                model: settings.model,
                length: settings.length,
                language: settings.language,
                tools: agentPayload.tools,
                automationEnabled: settings.automationEnabled,
              }),
              signal: agentController.signal,
            });
            if (!res.ok) {
              const rawText = await res.text().catch(() => "");
              const isMissingAgent =
                res.status === 404 || rawText.trim().toLowerCase() === "not found";
              const error = isMissingAgent
                ? "Daemon does not support /v1/agent. Restart the daemon after updating (summarize daemon restart)."
                : rawText.trim() || `${res.status} ${res.statusText}`;
              throw new Error(error);
            }

            let sawAssistant = false;
            for await (const event of readAgentResponse(res)) {
              if (!isStillActive()) return;
              if (event.type === "chunk") {
                void send(session, {
                  type: "agent:chunk",
                  requestId: agentPayload.requestId,
                  text: event.text,
                });
              } else if (event.type === "assistant") {
                sawAssistant = true;
                void send(session, {
                  type: "agent:response",
                  requestId: agentPayload.requestId,
                  ok: true,
                  assistant: event.assistant,
                });
              }
            }

            if (!sawAssistant) {
              throw new Error("Agent stream ended without a response.");
            }

            sendStatus(session, "");
          } catch (err) {
            if (agentController.signal.aborted) return;
            const message = friendlyFetchError(err, "Chat request failed");
            void send(session, {
              type: "agent:response",
              requestId: agentPayload.requestId,
              ok: false,
              error: message,
            });
            sendStatus(session, `Error: ${message}`);
          } finally {
            if (session.agentController === agentController) {
              session.agentController = null;
            }
          }
        })();
        break;
      case "panel:chat-history":
        void (async () => {
          const payload = raw as { requestId: string; summary?: string | null };
          const settings = await loadSettings();
          if (!settings.chatEnabled) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Chat is disabled in settings",
            });
            return;
          }
          if (!settings.token.trim()) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Setup required (missing token)",
            });
            return;
          }

          const tab = await getActiveTab(session.windowId);
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Cannot chat on this page",
            });
            return;
          }

          let cachedExtract: CachedExtract;
          try {
            cachedExtract = await ensureChatExtract({
              session,
              tab,
              settings,
              panelSessionStore,
              sendStatus: () => {},
              extractFromTab,
              fetchImpl: fetch,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: message,
            });
            return;
          }

          const summaryText = typeof payload.summary === "string" ? payload.summary.trim() : "";
          const pageContent = buildChatPageContent({
            transcript: cachedExtract.transcriptTimedText ?? cachedExtract.text,
            summary: summaryText,
            summaryCap: settings.maxChars,
            metadata: {
              url: cachedExtract.url,
              title: cachedExtract.title,
              source: cachedExtract.source,
              extractionStrategy:
                cachedExtract.source === "page"
                  ? "readability (content script)"
                  : (cachedExtract.diagnostics?.strategy ?? null),
              markdownProvider: cachedExtract.diagnostics?.markdown?.used
                ? (cachedExtract.diagnostics?.markdown?.provider ?? "unknown")
                : null,
              firecrawlUsed: cachedExtract.diagnostics?.firecrawl?.used ?? null,
              transcriptSource: cachedExtract.transcriptSource,
              transcriptionProvider: cachedExtract.transcriptionProvider,
              transcriptCache: cachedExtract.diagnostics?.transcript?.cacheStatus ?? null,
              attemptedTranscriptProviders:
                cachedExtract.diagnostics?.transcript?.attemptedProviders ?? null,
              mediaDurationSeconds: cachedExtract.mediaDurationSeconds,
              totalCharacters: cachedExtract.totalCharacters,
              wordCount: cachedExtract.wordCount,
              transcriptCharacters: cachedExtract.transcriptCharacters,
              transcriptWordCount: cachedExtract.transcriptWordCount,
              transcriptLines: cachedExtract.transcriptLines,
              transcriptHasTimestamps: Boolean(cachedExtract.transcriptTimedText),
              truncated: cachedExtract.truncated,
            },
          });
          const cacheContent = cachedExtract.transcriptTimedText ?? cachedExtract.text;

          try {
            const res = await fetch("http://127.0.0.1:8787/v1/agent/history", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${settings.token.trim()}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                url: cachedExtract.url,
                title: cachedExtract.title,
                pageContent,
                cacheContent,
                model: settings.model,
                length: settings.length,
                language: settings.language,
                automationEnabled: settings.automationEnabled,
              }),
            });
            const rawText = await res.text();
            let json: { ok?: boolean; messages?: Message[]; error?: string } | null = null;
            if (rawText) {
              try {
                json = JSON.parse(rawText) as typeof json;
              } catch {
                json = null;
              }
            }
            if (!res.ok || !json?.ok) {
              const error = json?.error ?? (rawText.trim() || `${res.status} ${res.statusText}`);
              throw new Error(error);
            }
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: true,
              messages: Array.isArray(json?.messages) ? json?.messages : undefined,
            });
          } catch (err) {
            const message = friendlyFetchError(err, "Chat history request failed");
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: message,
            });
          }
        })();
        break;
      case "panel:ping":
        void emitState(session, "", { checkRecovery: true });
        break;
      case "panel:rememberUrl":
        session.lastSummarizedUrl = (raw as { url: string }).url;
        session.inflightUrl = null;
        break;
      case "panel:setAuto":
        void (async () => {
          await patchSettings({ autoSummarize: (raw as { value: boolean }).value });
          void emitState(session, "");
          if ((raw as { value: boolean }).value) void summarizeActiveTab(session, "auto-enabled");
        })();
        break;
      case "panel:setLength":
        void (async () => {
          const next = (raw as { value: string }).value;
          const current = await loadSettings();
          if (current.length === next) return;
          await patchSettings({ length: next });
          void emitState(session, "");
          void summarizeActiveTab(session, "length-change");
        })();
        break;
      case "panel:slides-context":
        void (async () => {
          const payload = raw as { requestId?: string; url?: string };
          const requestId = payload.requestId;
          if (!requestId) return;
          const settings = await loadSettings();
          const logSlides = (event: string, detail?: Record<string, unknown>) => {
            if (!settings.extendedLogging) return;
            const payload = detail ? { event, ...detail } : { event };
            const detailPayload = detail ?? {};
            logExtensionEvent({
              event,
              detail: detailPayload,
              scope: "slides:bg",
              level: resolveLogLevel(event),
            });
            console.debug("[summarize][slides:bg]", payload);
          };
          const requestedUrl =
            typeof payload.url === "string" && payload.url.trim().length > 0
              ? payload.url.trim()
              : null;
          const tab = await getActiveTab(session.windowId);
          const tabUrl = typeof tab?.url === "string" ? tab.url : null;
          const targetUrl = requestedUrl ?? tabUrl;
          if (!targetUrl || !canSummarizeUrl(targetUrl)) {
            void send(session, {
              type: "slides:context",
              requestId,
              ok: false,
              error: "No active tab for slides.",
            });
            logSlides("context:error", { reason: "no-tab", url: targetUrl });
            return;
          }
          const canUseCache = Boolean(tab?.id && tabUrl && urlsMatch(tabUrl, targetUrl));
          let cached = canUseCache
            ? panelSessionStore.getCachedExtract(tab.id, tabUrl ?? null)
            : null;
          let transcriptTimedText = cached?.transcriptTimedText ?? null;
          if (!transcriptTimedText && settings.token.trim()) {
            try {
              const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${settings.token.trim()}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  url: targetUrl,
                  mode: "url",
                  extractOnly: true,
                  timestamps: true,
                  maxCharacters: null,
                }),
              });
              const json = (await res.json()) as {
                ok?: boolean;
                extracted?: { transcriptTimedText?: string | null } | null;
                error?: string;
              };
              if (!res.ok || !json?.ok) {
                throw new Error(json?.error || `${res.status} ${res.statusText}`);
              }
              transcriptTimedText = json.extracted?.transcriptTimedText ?? null;
              if (transcriptTimedText) {
                if (!cached && canUseCache && tab?.id && tabUrl) {
                  cached = {
                    url: tabUrl,
                    title: tab.title?.trim() ?? null,
                    text: "",
                    source: "url",
                    truncated: false,
                    totalCharacters: 0,
                    wordCount: null,
                    media: null,
                    transcriptSource: null,
                    transcriptionProvider: null,
                    transcriptCharacters: null,
                    transcriptWordCount: null,
                    transcriptLines: null,
                    transcriptTimedText,
                    mediaDurationSeconds: null,
                    slides: null,
                    diagnostics: null,
                  };
                } else if (cached) {
                  cached = { ...cached, transcriptTimedText };
                }
                if (cached && tab?.id) {
                  panelSessionStore.setCachedExtract(tab.id, cached);
                }
              }
              logSlides("context:fetch-transcript", {
                ok: Boolean(transcriptTimedText),
                url: targetUrl,
              });
            } catch (err) {
              logSlides("context:fetch-error", {
                url: targetUrl,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          void send(session, {
            type: "slides:context",
            requestId,
            ok: true,
            transcriptTimedText,
          });
          logSlides("context:ready", {
            url: targetUrl,
            transcriptTimedText: Boolean(transcriptTimedText),
            slides: cached?.slides?.slides?.length ?? 0,
          });
        })();
        break;
      case "panel:openOptions":
        void openOptionsWindow();
        break;
      case "panel:seek":
        void (async () => {
          const seconds = (raw as { seconds?: number }).seconds;
          if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
            return;
          }
          const tab = await getActiveTab(session.windowId);
          if (!tab?.id) return;
          const result = await seekInTab(tab.id, Math.floor(seconds));
          if (!result.ok) {
            sendStatus(session, `Seek failed: ${result.error}`);
          }
        })();
        break;
    }
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith("sidepanel:")) return;
    const windowIdRaw = port.name.split(":")[1] ?? "";
    const windowId = Number.parseInt(windowIdRaw, 10);
    if (!Number.isFinite(windowId)) return;
    const session = panelSessionStore.registerPanelSession(windowId, port);
    port.onMessage.addListener((msg) => handlePanelMessage(session, msg as PanelToBg));
    port.onDisconnect.addListener(() => {
      if (session.port !== port) return;
      session.runController?.abort();
      session.runController = null;
      session.panelOpen = false;
      session.panelLastPingAt = 0;
      session.lastSummarizedUrl = null;
      session.inflightUrl = null;
      session.daemonRecovery.clearPending();
      panelSessionStore.deletePanelSession(windowId);
      void panelSessionStore.clearCachedExtractsForWindow(windowId);
    });
  });

  chrome.runtime.onMessage.addListener(
    (
      raw: HoverToBg | NativeInputRequest | ArtifactsRequest,
      sender,
      sendResponse,
    ): boolean | undefined => {
      return (
        runtimeActionsHandler(raw, sender, sendResponse) ??
        hoverController.handleRuntimeMessage(raw, sender, sendResponse)
      );
    },
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes.settings) return;
    for (const session of panelSessionStore.getPanelSessions()) {
      void emitState(session, "");
    }
  });

  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void (async () => {
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      const windowId = tab?.windowId;
      if (typeof windowId !== "number") return;
      const session = panelSessionStore.getPanelSession(windowId);
      if (!session) return;
      const now = Date.now();
      if (now - session.lastNavAt < 700) return;
      session.lastNavAt = now;
      void emitState(session, "");
      void summarizeActiveTab(session, "spa-nav");
    })();
  });

  chrome.tabs.onActivated.addListener((info) => {
    const session = panelSessionStore.getPanelSession(info.windowId);
    if (!session) return;
    void emitState(session, "");
    void summarizeActiveTab(session, "tab-activated");
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    const windowId = tab?.windowId;
    if (typeof windowId !== "number") return;
    const session = panelSessionStore.getPanelSession(windowId);
    if (!session) return;
    if (typeof changeInfo.title === "string" || typeof changeInfo.url === "string") {
      void emitState(session, "");
    }
    if (typeof changeInfo.url === "string") {
      void summarizeActiveTab(session, "tab-url-change");
    }
    if (changeInfo.status === "complete") {
      void emitState(session, "");
      void summarizeActiveTab(session, "tab-updated");
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    panelSessionStore.clearTab(tabId);
    hoverController.abortHoverForTab(tabId);
    nativeInputArmedTabs.delete(tabId);
  });

  // Chrome: Auto-open side panel on toolbar icon click
  if (import.meta.env.BROWSER === "chrome") {
    void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  }

  // Firefox: Toggle sidebar on toolbar icon click
  // Firefox supports sidebarAction.toggle() for programmatic control
  if (import.meta.env.BROWSER === "firefox") {
    chrome.action.onClicked.addListener(() => {
      // @ts-expect-error - sidebarAction API exists in Firefox but not in Chrome types
      if (typeof browser?.sidebarAction?.toggle === "function") {
        // @ts-expect-error - Firefox-specific API
        void browser.sidebarAction.toggle();
      }
    });
  }
});
