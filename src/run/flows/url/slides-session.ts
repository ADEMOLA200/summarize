import { buildSlidesCacheKey } from "../../../cache.js";
import type { ExtractedLinkContent } from "../../../content/index.js";
import {
  extractSlidesForSource,
  resolveSlideSource,
  type SlideExtractionResult,
  validateSlidesCache,
} from "../../../slides/index.js";
import { writeVerbose } from "../../logging.js";
import { createSlidesTerminalOutput, type SlidesTerminalOutput } from "./slides-output.js";
import type { UrlFlowContext } from "./types.js";

type ProgressStatusLike = {
  clearSlides: () => void;
  setSlides: (text: string, percent?: number | null) => void;
};

export type UrlSlidesSession = {
  getSlidesExtracted: () => SlideExtractionResult | null;
  runSlidesExtraction: () => Promise<SlideExtractionResult | null>;
  slidesOutput: SlidesTerminalOutput | null;
  slidesTimelinePromise: Promise<SlideExtractionResult | null> | null;
  setExtracted: (value: ExtractedLinkContent) => void;
};

export function createUrlSlidesSession({
  ctx,
  url,
  extracted: initialExtracted,
  cacheStore,
  progressStatus,
  renderStatus,
  renderStatusFromText,
  updateSummaryProgress,
}: {
  ctx: UrlFlowContext;
  url: string;
  extracted: ExtractedLinkContent;
  cacheStore: UrlFlowContext["cache"]["store"] | null;
  progressStatus: ProgressStatusLike;
  renderStatus: (label: string, detail?: string) => string;
  renderStatusFromText: (text: string) => string;
  updateSummaryProgress: () => void;
}): UrlSlidesSession {
  const { io, flags, model, cache: cacheState, hooks } = ctx;
  let extracted = initialExtracted;
  let slidesExtracted: SlideExtractionResult | null = null;
  let slidesDone = false;
  let slidesTimelineResolved = false;
  let resolveSlidesTimeline: ((value: SlideExtractionResult | null) => void) | null = null;
  const slidesTimelinePromise = flags.slides
    ? new Promise<SlideExtractionResult | null>((resolve) => {
        resolveSlidesTimeline = resolve;
      })
    : null;

  const resolveTimeline = (value: SlideExtractionResult | null) => {
    if (slidesTimelineResolved) return;
    slidesTimelineResolved = true;
    resolveSlidesTimeline?.(value);
  };

  const slidesOutputEnabled =
    Boolean(flags.slides) && flags.slidesOutput !== false && !flags.json && !flags.extractMode;
  const slidesOutput = createSlidesTerminalOutput({
    io,
    flags: { plain: flags.plain, lengthArg: flags.lengthArg, slidesDebug: flags.slidesDebug },
    extracted,
    slides: null,
    enabled: slidesOutputEnabled,
    outputMode: "delta",
    clearProgressForStdout: hooks.clearProgressForStdout,
    restoreProgressAfterStdout: hooks.restoreProgressAfterStdout ?? null,
    onProgressText: flags.progressEnabled
      ? (text) => progressStatus.setSlides(renderStatusFromText(text))
      : null,
  });

  if (slidesOutput) {
    const existingSlidesExtracted = hooks.onSlidesExtracted;
    const existingSlidesDone = hooks.onSlidesDone;
    const existingSlideChunk = hooks.onSlideChunk;
    hooks.onSlidesExtracted = (value) => {
      existingSlidesExtracted?.(value);
      slidesOutput.onSlidesExtracted(value);
    };
    hooks.onSlidesDone = (result) => {
      existingSlidesDone?.(result);
      progressStatus.clearSlides();
      slidesOutput.onSlidesDone(result);
    };
    hooks.onSlideChunk = (chunk) => {
      existingSlideChunk?.(chunk);
      slidesOutput.onSlideChunk(chunk);
    };
  }

  const markSlidesDone = (result: { ok: boolean; error?: string | null }) => {
    if (slidesDone) return;
    slidesDone = true;
    progressStatus.clearSlides();
    hooks.onSlidesDone?.(result);
  };

  const runSlidesExtraction = async (): Promise<SlideExtractionResult | null> => {
    if (!flags.slides) return null;
    if (slidesExtracted) {
      if (!slidesDone) markSlidesDone({ ok: true });
      return slidesExtracted;
    }
    let errorMessage: string | null = null;
    try {
      const source = resolveSlideSource({ url, extracted });
      if (!source) {
        throw new Error("Slides are only supported for YouTube or direct video URLs.");
      }
      const slidesCacheKey =
        cacheStore && cacheState.mode === "default"
          ? buildSlidesCacheKey({ url: source.url, settings: flags.slides })
          : null;
      if (slidesCacheKey && cacheStore) {
        const cached = cacheStore.getJson<SlideExtractionResult>("slides", slidesCacheKey);
        const validated = cached
          ? await validateSlidesCache({ cached, source, settings: flags.slides })
          : null;
        if (validated) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            "cache hit slides",
            flags.verboseColor,
            io.envForRun,
          );
          slidesExtracted = validated;
          resolveTimeline(validated);
          ctx.hooks.onSlidesExtracted?.(slidesExtracted);
          ctx.hooks.onSlidesProgress?.("Slides: cached 100%");
          return slidesExtracted;
        }
        writeVerbose(
          io.stderr,
          flags.verbose,
          "cache miss slides",
          flags.verboseColor,
          io.envForRun,
        );
      }
      if (flags.progressEnabled) {
        progressStatus.setSlides(renderStatus("Extracting slides"));
      }
      ctx.hooks.onSlidesProgress?.("Slides: extracting");
      const onSlidesLog = (message: string) => {
        writeVerbose(
          io.stderr,
          flags.verbose,
          `slides ${message}`,
          flags.verboseColor,
          io.envForRun,
        );
      };
      slidesExtracted = await extractSlidesForSource({
        source,
        settings: flags.slides,
        noCache: cacheState.mode === "bypass",
        mediaCache: ctx.mediaCache,
        env: io.env,
        timeoutMs: flags.timeoutMs,
        ytDlpPath: model.apiStatus.ytDlpPath,
        ytDlpCookiesFromBrowser: model.apiStatus.ytDlpCookiesFromBrowser,
        ffmpegPath: null,
        tesseractPath: null,
        hooks: {
          onSlideChunk: (chunk) => ctx.hooks.onSlideChunk?.(chunk),
          onSlidesTimeline: (timeline) => {
            resolveTimeline(timeline);
            ctx.hooks.onSlidesExtracted?.(timeline);
          },
          onSlidesProgress: ctx.hooks.onSlidesProgress ?? undefined,
          onSlidesLog,
        },
      });
      if (slidesExtracted) {
        ctx.hooks.onSlidesExtracted?.(slidesExtracted);
        ctx.hooks.onSlidesProgress?.(
          `Slides: done (${slidesExtracted.slides.length.toString()} slides) 100%`,
        );
        if (slidesCacheKey && cacheStore) {
          cacheStore.setJson("slides", slidesCacheKey, slidesExtracted, cacheState.ttlMs);
          writeVerbose(
            io.stderr,
            flags.verbose,
            "cache write slides",
            flags.verboseColor,
            io.envForRun,
          );
        }
      }
      if (flags.progressEnabled) {
        updateSummaryProgress();
      }
      return slidesExtracted;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (!slidesTimelineResolved) {
        resolveTimeline(slidesExtracted ?? null);
      }
      if (!slidesDone) {
        markSlidesDone(errorMessage ? { ok: false, error: errorMessage } : { ok: true });
      }
    }
  };

  return {
    getSlidesExtracted: () => slidesExtracted,
    runSlidesExtraction,
    slidesOutput,
    slidesTimelinePromise,
    setExtracted: (value) => {
      extracted = value;
    },
  };
}
