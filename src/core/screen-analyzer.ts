import { desktopCapturer, nativeImage, screen } from 'electron';
import { AIConfigManager } from './ai-config';
import {
  SCREEN_FINGERPRINT_HEIGHT,
  SCREEN_FINGERPRINT_WIDTH,
  ScreenFingerprint,
  createScreenFingerprintFromBitmap,
} from './screen-fingerprint';

const DEFAULT_VISION_REQUEST_TIMEOUT_MS = 18000;
const LOCATE_TARGET_PRECISE_TIMEOUT_MS = 8000;
const LOCATE_TARGET_LEGACY_TIMEOUT_MS = 5500;
const LOCATE_TARGET_BEST_EFFORT_TIMEOUT_MS = 6500;
const LOCATE_TARGET_REFINE_TIMEOUT_MS = 4500;
const LOCATE_TARGET_REFINE_MIN_BUDGET_MS = 1200;
const LOCATE_TARGET_MAX_TOKENS = 760;
const RELIABLE_LOCATE_CONFIDENCE = 0.62;
const BEST_EFFORT_POINTABLE_CONFIDENCE = 0.35;
const LOW_PRECISION_CAPTURE_MAX_SIDE = 1440;
const HIGH_PRECISION_CAPTURE_MAX_SIDE = 2560;
const REFINE_CONFIDENCE_THRESHOLD = 0.4;
const REFINE_SMALL_BOX_MAX_WIDTH = 260;
const REFINE_SMALL_BOX_MAX_HEIGHT = 90;
const REFINE_CROP_MIN_SIDE = 280;
const REFINE_CROP_MAX_SIDE = 1100;
const REFINE_CROP_MAX_OUTPUT_SIDE = 1600;
const REFINE_CROP_MARGIN_MIN = 64;
const REFINE_CROP_MARGIN_MAX = 260;

export interface ScreenCaptureFrame {
  imageDataUri: string;
  origin: { x: number; y: number };
  screenSize: { width: number; height: number };
  imageSize: { width: number; height: number };
  fingerprint?: ScreenFingerprint;
}

export interface ScreenCaptureOptions {
  highPrecision?: boolean;
}

export interface ScreenVisionQueryOptions extends ScreenCaptureOptions {
  visionImageDetail?: 'low' | 'high';
  visionSystemPrompt?: string;
  visionRequestTimeoutMs?: number;
  visionMaxTokens?: number;
}

export interface ScreenVisionQueryResponse {
  text: string;
  frame: ScreenCaptureFrame;
}

export interface ScreenTargetBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenTargetLocateResult {
  found: boolean;
  label: string;
  confidence: number;
  point?: { x: number; y: number };
  box?: ScreenTargetBox;
  targetKind?: string;
  matchType?: string;
  reason?: string;
}

export interface ScreenTargetLocateResponse {
  result: ScreenTargetLocateResult;
  frame: ScreenCaptureFrame;
}

interface ScreenTargetRefinementCrop {
  imageDataUri: string;
  cropBox: ScreenTargetBox;
  imageSize: { width: number; height: number };
  scale: number;
}

export class ScreenAnalyzer {
  private configManager: AIConfigManager;

  constructor(configManager: AIConfigManager) {
    this.configManager = configManager;
  }

  /** 截屏并分析 */
  async analyze(userMessage: string): Promise<string> {
    const config = this.configManager.get();

    if (!config.visionApiKey || !config.visionBaseURL || !config.visionModel) {
      return '（屏幕分析未配置，请在设置中配置 Vision API）';
    }

    const frame = await this.captureScreenFrame();
    if (!frame) {
      return '（截屏失败）';
    }

    try {
      const response = await this.callVisionAPI(frame.imageDataUri, userMessage, config);
      return response;
    } catch (error: any) {
      console.error('[ScreenAnalyzer] Vision API 调用失败:', error.message);
      return '（屏幕分析失败: ' + error.message + '）';
    }
  }

  /** 截取屏幕，返回 base64 data URI。保留旧接口给现有调用方。 */
  async captureScreen(): Promise<string | null> {
    const frame = await this.captureScreenFrame();
    return frame?.imageDataUri ?? null;
  }

  /** 截图并用自定义提示词询问 Vision，供上层模块做结构化屏幕判断。 */
  async queryScreen(
    userMessage: string,
    options: ScreenVisionQueryOptions = {}
  ): Promise<ScreenVisionQueryResponse> {
    const config = this.configManager.get();
    if (!config.visionApiKey || !config.visionBaseURL || !config.visionModel) {
      throw new Error('屏幕分析未配置，请在设置中配置 Vision API');
    }

    const frame = await this.captureScreenFrame({ highPrecision: options.highPrecision });
    if (!frame) {
      throw new Error('截屏失败');
    }

    const text = await this.callVisionAPI(frame.imageDataUri, userMessage, {
      ...config,
      visionSystemPrompt: options.visionSystemPrompt,
      visionImageDetail: options.visionImageDetail,
      visionRequestTimeoutMs: options.visionRequestTimeoutMs,
      visionMaxTokens: options.visionMaxTokens,
    });

    return { text, frame };
  }

  /** 截取主屏幕并返回坐标映射所需元信息 */
  async captureScreenFrame(options: ScreenCaptureOptions = {}): Promise<ScreenCaptureFrame | null> {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const displays = screen.getAllDisplays();
      const thumbnailSize = resolveCaptureThumbnailSize(primaryDisplay.bounds, options);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
      });

      console.log('[ScreenAnalyzer][debug] capture sources:', {
        primaryDisplayId: primaryDisplay.id,
        primaryBounds: primaryDisplay.bounds,
        displayIds: displays.map(display => ({ id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor })),
        sourceIds: sources.map(source => ({ id: source.id, displayId: source.display_id, name: source.name })),
      });

      if (sources.length === 0) return null;

      const matchedSource = sources.find((source) => String(source.display_id) === String(primaryDisplay.id))
        ?? (sources.length === 1 ? sources[0] : undefined);
      if (!matchedSource) {
        console.error('[ScreenAnalyzer] 未找到主屏幕截图源，跳过可能错配的坐标映射');
        return null;
      }

      const matchedDisplay = displays.find((display) => String(display.id) === String(matchedSource.display_id)) ?? primaryDisplay;
      const resized = matchedSource.thumbnail.resize(thumbnailSize);
      let fingerprint: ScreenFingerprint | undefined;
      try {
        const fingerprintImage = matchedSource.thumbnail.resize({
          width: SCREEN_FINGERPRINT_WIDTH,
          height: SCREEN_FINGERPRINT_HEIGHT,
        });
        const fingerprintSize = fingerprintImage.getSize();
        fingerprint = createScreenFingerprintFromBitmap(
          fingerprintImage.toBitmap(),
          fingerprintSize.width,
          fingerprintSize.height
        ) ?? undefined;
      } catch (error: any) {
        console.warn('[ScreenAnalyzer] 屏幕指纹生成失败，继续返回截图帧:', error.message);
      }
      const imageSize = resized.getSize();
      const base64 = resized.toPNG().toString('base64');
      const frame: ScreenCaptureFrame = {
        imageDataUri: `data:image/png;base64,${base64}`,
        origin: { x: matchedDisplay.bounds.x, y: matchedDisplay.bounds.y },
        screenSize: { width: matchedDisplay.bounds.width, height: matchedDisplay.bounds.height },
        imageSize: { width: imageSize.width, height: imageSize.height },
        fingerprint,
      };

      console.log('[ScreenAnalyzer][debug] capture frame:', {
        sourceDisplayId: matchedSource.display_id,
        sourceName: matchedSource.name,
        origin: frame.origin,
        screenSize: frame.screenSize,
        imageSize: frame.imageSize,
        fingerprint: frame.fingerprint
          ? { width: frame.fingerprint.width, height: frame.fingerprint.height, values: frame.fingerprint.values.length }
          : null,
      });

      return frame;
    } catch (error: any) {
      console.error('[ScreenAnalyzer] 截屏失败:', error.message);
      return null;
    }
  }

  /** 截屏并让 Vision 模型定位用户描述的当前可见目标 */
  async locateTarget(
    userMessage: string,
    frameOverride?: ScreenCaptureFrame
  ): Promise<ScreenTargetLocateResponse> {
    const config = this.configManager.get();
    if (!config.visionApiKey || !config.visionBaseURL || !config.visionModel) {
      throw new Error('屏幕分析未配置，请在设置中配置 Vision API');
    }
    const locate = (options: ScreenCaptureOptions & {
      visionImageDetail: 'low' | 'high';
      promptMode: 'precise' | 'best-effort' | 'legacy';
      visionRequestTimeoutMs: number;
      visionMaxTokens?: number;
    }) => frameOverride
      ? this.locateTargetWithFrame(userMessage, frameOverride, options)
      : this.locateTargetWithCapture(userMessage, options);

    try {
      const preciseStartedAt = Date.now();
      const preciseBase = await locate({
        highPrecision: true,
        visionImageDetail: 'high',
        promptMode: 'precise',
        visionRequestTimeoutMs: LOCATE_TARGET_PRECISE_TIMEOUT_MS,
        visionMaxTokens: LOCATE_TARGET_MAX_TOKENS,
      });
      const precise = await this.refineLocateResponseIfUseful(
        userMessage,
        preciseBase,
        remainingBudgetMs(preciseStartedAt, LOCATE_TARGET_PRECISE_TIMEOUT_MS)
      );
      if (this.isReliableLocateResult(precise.result)) {
        return precise;
      }

      try {
        const bestEffortStartedAt = Date.now();
        const bestEffortBase = await locate({
          highPrecision: true,
          visionImageDetail: 'high',
          promptMode: 'best-effort',
          visionRequestTimeoutMs: LOCATE_TARGET_BEST_EFFORT_TIMEOUT_MS,
          visionMaxTokens: LOCATE_TARGET_MAX_TOKENS,
        });
        const bestEffort = await this.refineLocateResponseIfUseful(
          userMessage,
          bestEffortBase,
          remainingBudgetMs(bestEffortStartedAt, LOCATE_TARGET_BEST_EFFORT_TIMEOUT_MS)
        );
        return this.pickBetterLocateResponse(precise, bestEffort);
      } catch (fallbackError: any) {
        console.warn('[ScreenAnalyzer] Best-effort target locating failed; keeping precise result:', fallbackError?.message || fallbackError);
        return precise;
      }
    } catch (error: any) {
      if (!this.isVisionTimeoutError(error)) {
        throw error;
      }
      console.warn('[ScreenAnalyzer] 高精度定位超时，降级为旧判定方式:', error?.message || error);
    }

    return locate({
      highPrecision: false,
      visionImageDetail: 'low',
      promptMode: 'legacy',
      visionRequestTimeoutMs: LOCATE_TARGET_LEGACY_TIMEOUT_MS,
    });
  }

  private async locateTargetWithCapture(
    userMessage: string,
    options: ScreenCaptureOptions & {
      visionImageDetail: 'low' | 'high';
      promptMode: 'precise' | 'best-effort' | 'legacy';
      visionRequestTimeoutMs: number;
      visionMaxTokens?: number;
    }
  ): Promise<ScreenTargetLocateResponse> {
    const config = this.configManager.get();
    const frame = await this.captureScreenFrame({ highPrecision: options.highPrecision });
    if (!frame) {
      throw new Error('截屏失败');
    }
    return this.locateTargetWithFrame(userMessage, frame, options);
  }

  private async locateTargetWithFrame(
    userMessage: string,
    frame: ScreenCaptureFrame,
    options: {
      visionImageDetail: 'low' | 'high';
      promptMode: 'precise' | 'best-effort' | 'legacy';
      visionRequestTimeoutMs: number;
      visionMaxTokens?: number;
    }
  ): Promise<ScreenTargetLocateResponse> {
    const config = this.configManager.get();
    const response = await this.callVisionAPI(
      frame.imageDataUri,
      this.buildLocatePromptForMode(userMessage, frame, options.promptMode),
      {
        ...config,
        visionSystemPrompt: [
          'You are a precise screen target locator.',
          'You must locate Chinese text, English text, icons, images, buttons, inputs, links, menus, and window controls on the screenshot.',
          'Return one valid JSON object only. Do not use Markdown.',
        ].join('\n'),
        visionImageDetail: options.visionImageDetail,
        visionRequestTimeoutMs: options.visionRequestTimeoutMs,
        visionMaxTokens: options.visionMaxTokens,
      }
    );

    return {
      result: this.parseLocateResult(response, frame),
      frame,
    };
  }

  private async refineLocateResponseIfUseful(
    userMessage: string,
    response: ScreenTargetLocateResponse,
    timeBudgetMs: number = LOCATE_TARGET_REFINE_TIMEOUT_MS
  ): Promise<ScreenTargetLocateResponse> {
    if (!this.shouldRefineLocateResult(response.result, response.frame)) {
      return response;
    }
    if (timeBudgetMs < LOCATE_TARGET_REFINE_MIN_BUDGET_MS) {
      return response;
    }

    const crop = this.createRefinementCrop(response.frame, response.result);
    if (!crop) return response;
    const refineTimeoutMs = Math.min(LOCATE_TARGET_REFINE_TIMEOUT_MS, timeBudgetMs);

    try {
      const config = this.configManager.get();
      const raw = await this.callVisionAPI(
        crop.imageDataUri,
        this.buildRefineLocatePrompt(userMessage, response.result, crop),
        {
          ...config,
          visionSystemPrompt: 'You are a zoomed crop target verifier. Return one valid JSON object only. Do not use Markdown.',
          visionImageDetail: 'high',
          visionRequestTimeoutMs: refineTimeoutMs,
          visionMaxTokens: LOCATE_TARGET_MAX_TOKENS,
        }
      );
      const localFrame = this.createLocalFrameForCrop(crop);
      const refinedLocal = this.parseLocateResult(raw, localFrame);
      const refined = this.mapRefinedResultToParentFrame(response.result, refinedLocal, crop);
      if (!this.isUsefulRefinedResult(refined, response.result)) {
        return response;
      }

      console.log('[ScreenAnalyzer][debug] algorithm3 refined locate result:', {
        original: response.result,
        crop: {
          cropBox: crop.cropBox,
          imageSize: crop.imageSize,
          scale: crop.scale,
        },
        refinedLocal,
        refined,
      });
      return { result: refined, frame: response.frame };
    } catch (error: any) {
      console.warn('[ScreenAnalyzer] Algorithm3 crop refinement skipped:', error?.message || error);
      return response;
    }
  }

  private shouldRefineLocateResult(result: ScreenTargetLocateResult, frame: ScreenCaptureFrame): boolean {
    if (!this.isPointableLocateResult(result)) return false;
    const box = result.box;
    if (!box) return result.confidence < 0.86;

    const frameArea = Math.max(1, frame.imageSize.width * frame.imageSize.height);
    const boxArea = Math.max(1, box.width * box.height);
    const smallTextOrIconLike = box.width <= REFINE_SMALL_BOX_MAX_WIDTH || box.height <= REFINE_SMALL_BOX_MAX_HEIGHT;
    const notTooLarge = boxArea / frameArea <= 0.2;
    const uncertainty = result.confidence < 0.9;
    const semanticNeedsPrecision = ['text', 'button', 'input', 'icon', 'menu', 'link'].includes((result.targetKind || '').toLowerCase());
    return notTooLarge && (uncertainty || smallTextOrIconLike || semanticNeedsPrecision);
  }

  private createRefinementCrop(
    frame: ScreenCaptureFrame,
    result: ScreenTargetLocateResult
  ): ScreenTargetRefinementCrop | null {
    const cropBox = this.resolveRefinementCropBox(frame, result);
    if (!cropBox) return null;

    const sourceImage = nativeImage.createFromDataURL(frame.imageDataUri);
    if (sourceImage.isEmpty()) return null;

    const cropped = sourceImage.crop(cropBox);
    if (cropped.isEmpty()) return null;

    const scale = resolveCropZoomScale(cropBox);
    const outputSize = {
      width: Math.max(1, Math.round(cropBox.width * scale)),
      height: Math.max(1, Math.round(cropBox.height * scale)),
    };
    const enlarged = scale > 1 ? cropped.resize(outputSize) : cropped;
    const imageSize = enlarged.getSize();
    return {
      imageDataUri: enlarged.toDataURL(),
      cropBox,
      imageSize,
      scale,
    };
  }

  private resolveRefinementCropBox(
    frame: ScreenCaptureFrame,
    result: ScreenTargetLocateResult
  ): ScreenTargetBox | null {
    const focusBox = result.box ?? this.boxAroundPoint(result.point, frame);
    if (!focusBox) return null;

    const centerX = focusBox.x + focusBox.width / 2;
    const centerY = focusBox.y + focusBox.height / 2;
    const maxFocusSide = Math.max(focusBox.width, focusBox.height);
    const margin = clamp(maxFocusSide * 1.15, REFINE_CROP_MARGIN_MIN, REFINE_CROP_MARGIN_MAX);
    const desiredWidth = clamp(
      Math.max(focusBox.width + margin * 2, REFINE_CROP_MIN_SIDE),
      REFINE_CROP_MIN_SIDE,
      Math.min(REFINE_CROP_MAX_SIDE, frame.imageSize.width)
    );
    const desiredHeight = clamp(
      Math.max(focusBox.height + margin * 2, REFINE_CROP_MIN_SIDE),
      REFINE_CROP_MIN_SIDE,
      Math.min(REFINE_CROP_MAX_SIDE, frame.imageSize.height)
    );
    const left = clamp(centerX - desiredWidth / 2, 0, frame.imageSize.width - desiredWidth);
    const top = clamp(centerY - desiredHeight / 2, 0, frame.imageSize.height - desiredHeight);

    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(desiredWidth)),
      height: Math.max(1, Math.round(desiredHeight)),
    };
  }

  private boxAroundPoint(
    point: { x: number; y: number } | undefined,
    frame: ScreenCaptureFrame
  ): ScreenTargetBox | undefined {
    if (!point) return undefined;
    const side = Math.min(REFINE_CROP_MIN_SIDE, frame.imageSize.width, frame.imageSize.height);
    const x = clamp(point.x - side / 2, 0, frame.imageSize.width - side);
    const y = clamp(point.y - side / 2, 0, frame.imageSize.height - side);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(side)),
      height: Math.max(1, Math.round(side)),
    };
  }

  private createLocalFrameForCrop(crop: ScreenTargetRefinementCrop): ScreenCaptureFrame {
    return {
      imageDataUri: crop.imageDataUri,
      origin: { x: 0, y: 0 },
      screenSize: { ...crop.imageSize },
      imageSize: { ...crop.imageSize },
    };
  }

  private buildRefineLocatePrompt(
    userMessage: string,
    previous: ScreenTargetLocateResult,
    crop: ScreenTargetRefinementCrop
  ): string {
    return [
      'Algorithm 3 refinement pass: this image is a zoomed crop from the full screenshot.',
      `User request: ${userMessage}`,
      `Previous full-screen candidate: label="${previous.label || ''}", kind="${previous.targetKind || ''}", match="${previous.matchType || ''}", confidence=${previous.confidence}.`,
      `Crop image size: ${crop.imageSize.width}x${crop.imageSize.height}.`,
      `Crop maps to full screenshot image box: x=${crop.cropBox.x}, y=${crop.cropBox.y}, width=${crop.cropBox.width}, height=${crop.cropBox.height}, zoom=${crop.scale}.`,
      'Coordinates you return must be in this crop image, after zoom, with origin at the crop top-left.',
      'If the request asks for Chinese text, a Chinese term, 字样, 词条, or 文字: do OCR and return the tight box around the exact visible text.',
      'If the request asks for an icon, 图标, 图案, logo, symbol, or picture: return the visual object box itself; use nearby labels only to disambiguate.',
      'If the request asks for a button/link/menu/input: return the whole clickable control box, not only the text glyphs.',
      'Inspect exact text, partial text, button/link text, placeholder text, menu text, title text, and nearby labels.',
      'Also inspect icons, logos, button outlines, input boxes, checkboxes, selected tabs, and visual grouping.',
      'Return the most exact clickable/text center. If the target is text, box the text. If it is a button or input, box the whole control.',
      'If the previous candidate is wrong but the correct target is visible inside this crop, return the correct target.',
      'If no related target exists inside this crop, return found=false.',
      'Output one JSON object only. No Markdown.',
      '{"found":true,"label":"target name","targetKind":"button|text|input|icon|menu|region","matchType":"exact_text|partial_text|icon|context|best_effort","confidence":0.86,"box":{"x":80,"y":120,"width":220,"height":54},"point":{"x":190,"y":147},"reason":"why this crop confirms the target"}',
      '{"found":false,"label":"target name","confidence":0,"reason":"target is not inside this crop"}',
    ].join('\n');
  }

  private mapRefinedResultToParentFrame(
    original: ScreenTargetLocateResult,
    refinedLocal: ScreenTargetLocateResult,
    crop: ScreenTargetRefinementCrop
  ): ScreenTargetLocateResult {
    const point = refinedLocal.point
      ? {
          x: Math.round(crop.cropBox.x + refinedLocal.point.x / crop.scale),
          y: Math.round(crop.cropBox.y + refinedLocal.point.y / crop.scale),
        }
      : undefined;
    const box = refinedLocal.box
      ? {
          x: Math.round(crop.cropBox.x + refinedLocal.box.x / crop.scale),
          y: Math.round(crop.cropBox.y + refinedLocal.box.y / crop.scale),
          width: Math.max(1, Math.round(refinedLocal.box.width / crop.scale)),
          height: Math.max(1, Math.round(refinedLocal.box.height / crop.scale)),
        }
      : undefined;

    return {
      found: refinedLocal.found && !!point,
      label: refinedLocal.label || original.label,
      confidence: refinedLocal.confidence >= REFINE_CONFIDENCE_THRESHOLD
        ? Math.max(refinedLocal.confidence, Math.min(original.confidence, refinedLocal.confidence + 0.1))
        : refinedLocal.confidence,
      point,
      box,
      targetKind: refinedLocal.targetKind || original.targetKind,
      matchType: refinedLocal.matchType || original.matchType || 'crop_refined',
      reason: refinedLocal.reason
        ? `Algorithm3 crop refinement: ${refinedLocal.reason}`
        : 'Algorithm3 crop refinement',
    };
  }

  private isUsefulRefinedResult(
    refined: ScreenTargetLocateResult,
    original: ScreenTargetLocateResult
  ): boolean {
    if (!refined.found || !refined.point) return false;
    if (!Number.isFinite(refined.confidence) || refined.confidence < REFINE_CONFIDENCE_THRESHOLD) return false;
    if (!original.point) return true;
    const shift = distanceBetween(refined.point, original.point);
    if (refined.confidence >= original.confidence) return true;
    return shift <= 80 && refined.confidence >= BEST_EFFORT_POINTABLE_CONFIDENCE;
  }

  private isVisionTimeoutError(error: any): boolean {
    const message = String(error?.message || error || '');
    if (error?.name === 'AbortError') return true;
    if (message.includes('超时') || message.toLowerCase().includes('timeout')) return true;
    return /\(408\)/.test(message);
  }

  private isReliableLocateResult(result: ScreenTargetLocateResult): boolean {
    return result.found === true
      && !!result.point
      && Number.isFinite(result.point.x)
      && Number.isFinite(result.point.y)
      && Number.isFinite(result.confidence)
      && result.confidence >= RELIABLE_LOCATE_CONFIDENCE;
  }

  private pickBetterLocateResponse(
    primary: ScreenTargetLocateResponse,
    fallback: ScreenTargetLocateResponse
  ): ScreenTargetLocateResponse {
    const primaryPointable = this.isPointableLocateResult(primary.result);
    const fallbackPointable = this.isPointableLocateResult(fallback.result);
    if (!primaryPointable && fallbackPointable) return fallback;
    if (primaryPointable && !fallbackPointable) return primary;
    if (!primaryPointable && !fallbackPointable) return primary;

    if (fallback.result.found && !primary.result.found) return fallback;
    if (fallback.result.confidence > primary.result.confidence + 0.04) return fallback;
    return primary;
  }

  private isPointableLocateResult(result: ScreenTargetLocateResult): boolean {
    return !!result.point
      && Number.isFinite(result.point.x)
      && Number.isFinite(result.point.y)
      && Number.isFinite(result.confidence)
      && result.confidence >= BEST_EFFORT_POINTABLE_CONFIDENCE;
  }

  mapPointToScreen(frame: ScreenCaptureFrame, point: { x: number; y: number }): { x: number; y: number } {
    const scaleX = frame.screenSize.width / frame.imageSize.width;
    const scaleY = frame.screenSize.height / frame.imageSize.height;
    const screenPoint = {
      x: Math.round(frame.origin.x + point.x * scaleX),
      y: Math.round(frame.origin.y + point.y * scaleY),
    };
    console.log('[ScreenAnalyzer][debug] map point to screen:', {
      point,
      origin: frame.origin,
      screenSize: frame.screenSize,
      imageSize: frame.imageSize,
      scaleX,
      scaleY,
      screenPoint,
    });
    return screenPoint;
  }

  private buildLocatePromptForMode(
    userMessage: string,
    frame: ScreenCaptureFrame,
    mode: 'precise' | 'best-effort' | 'legacy'
  ): string {
    if (mode === 'precise') return this.buildPreciseLocatePrompt(userMessage, frame);
    if (mode === 'best-effort') return this.buildBestEffortLocatePrompt(userMessage, frame);
    return this.buildLocatePrompt(userMessage, frame);
  }

  private buildPreciseLocatePrompt(userMessage: string, frame: ScreenCaptureFrame): string {
    return [
      'Locate exactly one visible screen target in the current screenshot.',
      `User request: ${userMessage}`,
      `Screenshot size: ${frame.imageSize.width}x${frame.imageSize.height}`,
      'Coordinate rules: origin is the screenshot top-left corner, x grows right, y grows down.',
      'Ignore any Project-Ze desktop pet, companion bubble, guide panel, or controls such as 我完成了 / 重新识别 / 退出 if they appear in the screenshot.',
      'Important target classes:',
      '- Chinese text / 汉语词条 / 文字 / 字样: OCR first. Match the exact visible Chinese characters. Return a tight box around the visible text itself.',
      '- Icon / 图标 / 图案 / logo / symbol / picture: inspect shapes and pictograms. Return the icon/object box itself. Use nearby text only to choose the right icon.',
      '- Button / link / menu / input: match text, placeholder, icon, color, and surrounding labels. Return the whole clickable control box.',
      '- Download/install targets: prefer visible controls named Download, 下载, Get, Install, 安装, Windows, Client, 官网, official download.',
      'First do OCR: read all visible text, including Chinese and English button text, link text, menu text, labels, placeholders, tabs, titles, and nearby captions.',
      'Also inspect visual patterns: icons, logos, colored buttons, input boxes, checkboxes, menus, window controls, and text-associated controls.',
      'Match by exact text first, then partial text, Chinese/English equivalent, icon meaning, and surrounding UI context.',
      'Return the tight bounding box of the visible target as box: {x,y,width,height}.',
      'Return point as the clickable center of that box unless a more precise useful point is obvious.',
      'If several candidates exist, return candidates sorted by usefulness and set point/box to the best one.',
      'Include candidates whenever there is any ambiguity. Each candidate should have label, targetKind, matchType, confidence, box, point, reason.',
      'If the target is partially visible, still return the visible part with lower confidence.',
      'If the user requests a target by quoted text, exact OCR match is mandatory when visible.',
      'If the user requests an icon by meaning, do not require text; locate the most semantically matching visible icon.',
      'If several candidates exist, choose the one most likely to satisfy the user request now; include lower confidence instead of refusing.',
      'Only return found=false when no related visible text, icon, or UI candidate exists in the screenshot.',
      'Output one JSON object only. No Markdown.',
      '{"found":true,"label":"target name","targetKind":"button|text|input|icon|menu|region","matchType":"exact_text|partial_text|icon|context|best_effort","confidence":0.82,"box":{"x":80,"y":180,"width":120,"height":40},"point":{"x":140,"y":200},"reason":"why this is the target"}',
      '{"found":false,"label":"target name","confidence":0,"reason":"target is not visible in this screenshot"}',
    ].join('\n');
  }

  private buildBestEffortLocatePrompt(userMessage: string, frame: ScreenCaptureFrame): string {
    return [
      'Find the best visible candidate for the user request. Prefer pointing to something useful over saying not found.',
      `User request: ${userMessage}`,
      `Screenshot size: ${frame.imageSize.width}x${frame.imageSize.height}`,
      'Coordinate rules: origin is the screenshot top-left corner, x grows right, y grows down.',
      'Ignore any Project-Ze desktop pet, companion bubble, guide panel, or controls such as 我完成了 / 重新识别 / 退出 if they appear in the screenshot.',
      'Read visible text carefully. Chinese text, English text, button words, placeholders, and labels are as important as icons and pictures.',
      'For 汉语词条/文字/字样, point to the text itself. For 图标/logo/图案, point to the visual object itself. For buttons/links/inputs, point to the full clickable control.',
      'Consider exact text, partial text, Chinese/English equivalents, icon meaning, nearby labels, placeholders, tabs, and window title context.',
      'For download/install flows, look for Download, 下载, Get, Install, 安装, Windows, Client, official, 官网, setup, installer, .exe, .msi.',
      'If the exact target is not visible but a related next-step candidate is visible, return that best candidate with confidence between 0.35 and 0.70.',
      'If there are multiple plausible candidates, rank them in candidates and set point/box to the best one.',
      'Use found=true whenever there is a visible candidate worth pointing at. Use found=false only when the screenshot contains nothing related.',
      'Return a tight box and a point at the clickable/text center.',
      'Output one JSON object only. No Markdown.',
      '{"found":true,"label":"best visible candidate","targetKind":"button|text|input|icon|menu|region","matchType":"best_effort","confidence":0.56,"box":{"x":80,"y":180,"width":120,"height":40},"point":{"x":140,"y":200},"candidates":[{"label":"candidate A","confidence":0.56,"box":{"x":80,"y":180,"width":120,"height":40},"point":{"x":140,"y":200}},{"label":"candidate B","confidence":0.44,"box":{"x":300,"y":180,"width":110,"height":36},"point":{"x":355,"y":198}}],"reason":"why this is the most useful visible candidate"}',
      '{"found":false,"label":"target name","confidence":0,"reason":"no related visible text, icon, or UI candidate"}',
    ].join('\n');
  }

  private buildLocatePrompt(userMessage: string, frame: ScreenCaptureFrame): string {
    return [
      'Locate one visible screen target in the current screenshot.',
      `User request: ${userMessage}`,
      `Screenshot size: ${frame.imageSize.width}x${frame.imageSize.height}`,
      'Coordinate rules: point must be screenshot pixel coordinates, origin top-left, x right, y down.',
      'Ignore any Project-Ze desktop pet, companion bubble, guide panel, or controls such as 我完成了 / 重新识别 / 退出 if they appear in the screenshot.',
      'Read visible Chinese/English text first, then inspect icons and UI shapes. Button/link/input text and nearby labels are important.',
      'For text targets, point to the text itself. For icon targets, point to the icon itself. For clickable controls, point to the whole control.',
      'Return a useful visible candidate when possible. Use lower confidence for partial/uncertain matches instead of refusing.',
      'Return found=false only when no related visible candidate exists.',
      'Output one JSON object only. No Markdown.',
      '{"found":true,"label":"target name","confidence":0.62,"box":{"x":80,"y":180,"width":120,"height":40},"point":{"x":140,"y":200},"reason":"why this is the target"}',
      '{"found":false,"label":"target name","confidence":0,"reason":"target is not visible"}',
    ].join('\n');
  }

  private parseLocateResult(raw: string, frame: ScreenCaptureFrame): ScreenTargetLocateResult {
    const fallback: ScreenTargetLocateResult = {
      found: false,
      label: '',
      confidence: 0,
      reason: 'Vision 未返回可解析的定位结果',
    };

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return fallback;
      const parsed = JSON.parse(match[0]) as any;
      const payload = this.resolveLocatePayload(parsed);
      const confidence = this.parseConfidence(payload.confidence ?? parsed.confidence);
      const label = this.parseText(payload.label ?? parsed.label);
      const reason = this.parseText(payload.reason ?? parsed.reason);
      const targetKind = this.parseText(payload.targetKind ?? payload.kind ?? parsed.targetKind ?? parsed.kind);
      const matchType = this.parseText(payload.matchType ?? payload.match ?? parsed.matchType ?? parsed.match);
      const box = this.parseBox(
        payload.box ??
          payload.bbox ??
          payload.box_2d ??
          payload.bbox_2d ??
          payload.boundingBox ??
          payload.bounding_box ??
          payload.bounds ??
          payload.region ??
          payload.rect ??
          payload.rectangle ??
          payload.area ??
          payload.location,
        frame
      );
      const point = this.parsePoint(
        payload.point ??
          payload.center ??
          payload.coordinate ??
          payload.coordinates ??
          payload.position ??
          payload.location,
        frame
      ) ?? this.centerOfBox(box);
      const locateResult = {
        found: !!point && (payload.found === true || parsed.found === true || confidence >= BEST_EFFORT_POINTABLE_CONFIDENCE),
        label,
        confidence,
        point,
        box,
        targetKind,
        matchType,
        reason,
      };
      console.log('[ScreenAnalyzer][debug] locate result:', locateResult);
      return locateResult;
    } catch (error: any) {
      console.error('[ScreenAnalyzer] 定位 JSON 解析失败:', error.message, raw);
      return fallback;
    }
  }

  private resolveLocatePayload(parsed: any): any {
    const candidates = Array.isArray(parsed?.candidates)
      ? parsed.candidates.filter((candidate: any) => candidate && typeof candidate === 'object')
      : [];
    if (candidates.length === 0) return parsed;

    const sortedCandidates = candidates
      .slice()
      .sort((a: any, b: any) => {
        const aHasLocation = this.hasRawLocation(a) ? 1 : 0;
        const bHasLocation = this.hasRawLocation(b) ? 1 : 0;
        if (aHasLocation !== bHasLocation) return bHasLocation - aHasLocation;
        return this.parseConfidence(b.confidence) - this.parseConfidence(a.confidence);
      });
    const topCandidate = sortedCandidates[0];
    const parsedHasLocation = this.hasRawLocation(parsed);
    if (parsedHasLocation && parsed.found !== false) return parsed;

    return {
      ...parsed,
      ...topCandidate,
      label: topCandidate.label ?? parsed.label,
      reason: topCandidate.reason ?? parsed.reason,
      targetKind: topCandidate.targetKind ?? topCandidate.kind ?? parsed.targetKind ?? parsed.kind,
      matchType: topCandidate.matchType ?? topCandidate.match ?? parsed.matchType ?? parsed.match,
      confidence: topCandidate.confidence ?? parsed.confidence,
      found: topCandidate.found ?? parsed.found,
    };
  }

  private hasRawLocation(value: any): boolean {
    if (!value || typeof value !== 'object') return false;
    return !!(
      value.point ||
      value.center ||
      value.coordinate ||
      value.coordinates ||
      value.position ||
      value.box ||
      value.bbox ||
      value.box_2d ||
      value.bbox_2d ||
      value.boundingBox ||
      value.bounding_box ||
      value.bounds ||
      value.region ||
      value.rect ||
      value.rectangle ||
      value.area ||
      value.location
    );
  }

  private parseConfidence(value: any): number {
    const confidence = Number(value);
    return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  }

  private parseText(value: any): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private parsePoint(value: any, frame: ScreenCaptureFrame): { x: number; y: number } | undefined {
    if (!value) return undefined;
    if (Array.isArray(value) && value.length >= 2) {
      return this.parsePoint({ x: value[0], y: value[1] }, frame);
    }
    if (typeof value !== 'object') return undefined;
    const x = Number(value.x ?? value.left ?? value.cx ?? value.centerX);
    const y = Number(value.y ?? value.top ?? value.cy ?? value.centerY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    if (isNormalizedCoordinate(x) && isNormalizedCoordinate(y)) {
      return {
        x: Math.round(x * frame.imageSize.width),
        y: Math.round(y * frame.imageSize.height),
      };
    }
    if (x < 0 || y < 0 || x > frame.imageSize.width || y > frame.imageSize.height) return undefined;
    return { x: Math.round(x), y: Math.round(y) };
  }

  private parseBox(value: any, frame: ScreenCaptureFrame): ScreenTargetBox | undefined {
    if (!value) return undefined;
    if (Array.isArray(value) && value.length >= 4) {
      const values = value.slice(0, 4).map(Number);
      if (values.every(Number.isFinite) && values.every(isNormalizedCoordinate)) {
        const [a, b, c, d] = values;
        if (c > a && d > b) {
          return this.parseBox({
            left: a * frame.imageSize.width,
            top: b * frame.imageSize.height,
            right: c * frame.imageSize.width,
            bottom: d * frame.imageSize.height,
          }, frame);
        }
        return this.parseBox({
          x: a * frame.imageSize.width,
          y: b * frame.imageSize.height,
          width: c * frame.imageSize.width,
          height: d * frame.imageSize.height,
        }, frame);
      }

      const left = values[0];
      const top = values[1];
      const right = values[2];
      const bottom = values[3];
      if (
        Number.isFinite(left) &&
        Number.isFinite(top) &&
        Number.isFinite(right) &&
        Number.isFinite(bottom) &&
        right > left &&
        bottom > top &&
        right <= frame.imageSize.width &&
        bottom <= frame.imageSize.height
      ) {
        return this.parseBox({ left, top, right, bottom }, frame);
      }
      return this.parseBox({ x: value[0], y: value[1], width: value[2], height: value[3] }, frame);
    }
    if (typeof value !== 'object') return undefined;
    const rawX = Number(value.x ?? value.left ?? value.x1);
    const rawY = Number(value.y ?? value.top ?? value.y1);
    const rightValue = value.right ?? value.x2;
    const bottomValue = value.bottom ?? value.y2;
    let rawWidth = Number(value.width ?? value.w ?? (rightValue !== undefined ? Number(rightValue) - rawX : undefined));
    let rawHeight = Number(value.height ?? value.h ?? (bottomValue !== undefined ? Number(bottomValue) - rawY : undefined));
    if (
      !Number.isFinite(rawX) ||
      !Number.isFinite(rawY) ||
      !Number.isFinite(rawWidth) ||
      !Number.isFinite(rawHeight) ||
      rawWidth <= 0 ||
      rawHeight <= 0
    ) {
      return undefined;
    }

    let x = rawX;
    let y = rawY;
    if (
      isNormalizedCoordinate(rawX) &&
      isNormalizedCoordinate(rawY) &&
      isNormalizedCoordinate(rawWidth) &&
      isNormalizedCoordinate(rawHeight)
    ) {
      x = rawX * frame.imageSize.width;
      y = rawY * frame.imageSize.height;
      rawWidth = rawWidth * frame.imageSize.width;
      rawHeight = rawHeight * frame.imageSize.height;
    }

    const left = clamp(x, 0, frame.imageSize.width);
    const top = clamp(y, 0, frame.imageSize.height);
    const right = clamp(x + rawWidth, 0, frame.imageSize.width);
    const bottom = clamp(y + rawHeight, 0, frame.imageSize.height);
    if (right <= left || bottom <= top) return undefined;

    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(right - left),
      height: Math.round(bottom - top),
    };
  }

  private centerOfBox(box: ScreenTargetBox | undefined): { x: number; y: number } | undefined {
    if (!box) return undefined;
    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
  }

  /** 调用 Vision API（OpenAI 兼容格式） */
  private async callVisionAPI(
    imageDataUri: string,
    userMessage: string,
    config: any
  ): Promise<string> {
    const messages = [
      {
        role: 'system',
        content: config.visionSystemPrompt || '你是一个桌面助手，简短描述用户屏幕上的内容。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userMessage || '描述一下屏幕上有什么' },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUri,
              detail: config.visionImageDetail || 'low',
            },
          },
        ],
      },
    ];

    const timeoutMs = resolveVisionRequestTimeoutMs(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${config.visionBaseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.visionApiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.visionModel,
          messages,
          max_tokens: resolveVisionMaxTokens(config),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API 请求失败 (${response.status}): ${error}`);
      }

      const data = await response.json() as any;
      return data.choices?.[0]?.message?.content ?? '（无响应）';
    } catch (error: any) {
      if (controller.signal.aborted) {
        throw new Error(`Vision 请求超时（${Math.round(timeoutMs / 1000)}秒）`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveCaptureThumbnailSize(
  bounds: { width: number; height: number },
  options: ScreenCaptureOptions
): { width: number; height: number } {
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const maxSide = options.highPrecision ? HIGH_PRECISION_CAPTURE_MAX_SIDE : LOW_PRECISION_CAPTURE_MAX_SIDE;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isNormalizedCoordinate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function resolveCropZoomScale(cropBox: ScreenTargetBox): number {
  const maxSide = Math.max(1, cropBox.width, cropBox.height);
  const scale = REFINE_CROP_MAX_OUTPUT_SIDE / maxSide;
  return Math.max(1, Math.min(4, scale));
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function remainingBudgetMs(startedAt: number, totalBudgetMs: number): number {
  return Math.max(0, totalBudgetMs - (Date.now() - startedAt));
}

function resolveVisionRequestTimeoutMs(config: any): number {
  const value = Number(config?.visionRequestTimeoutMs);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_VISION_REQUEST_TIMEOUT_MS;
  return Math.min(60000, Math.max(3000, Math.round(value)));
}

function resolveVisionMaxTokens(config: any): number {
  const value = Number(config?.visionMaxTokens);
  if (!Number.isFinite(value) || value <= 0) return 1000;
  return Math.min(1000, Math.max(64, Math.round(value)));
}
