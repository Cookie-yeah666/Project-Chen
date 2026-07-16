import { BrowserWindow, screen } from 'electron';
import { BubbleOrchestrator } from './bubble-orchestrator';
import { MoveController, MoveResult } from './move-controller';
import { ScreenAnalyzer, ScreenCaptureFrame, ScreenTargetLocateResult } from './screen-analyzer';
import {
  SCREEN_FINGERPRINT_CHANGE_THRESHOLD,
  compareScreenFingerprints,
} from './screen-fingerprint';
import {
  PointerPose,
  PointerPoseCandidate,
  PointerPoseConfig,
  resolvePointerPoseCandidate,
} from './screen-target-alignment';
import { WindowActivityService } from './window-activity-service';

export type { PointerPose, PointerPoseConfig } from './screen-target-alignment';
export type ScreenPointingSessionState = 'capturing' | 'locating' | 'moving' | 'pointing' | 'cancelled' | 'done';
export type ScreenTargetPointerCancelReason = 'new-request' | 'screen-changed' | 'drag-start' | 'manual';

export interface PointVisualEvent {
  active: boolean;
  pose?: PointerPose;
  reason?: string;
}

export interface ScreenTargetPointerResult {
  handled: boolean;
  moved: boolean;
  message: string;
  locateResult?: ScreenTargetLocateResult;
  cancelReason?: ScreenTargetPointerCancelReason;
}

interface ScreenTargetPointerOptions {
  mainWindow: BrowserWindow;
  screenAnalyzer: ScreenAnalyzer;
  moveController: MoveController;
  bubbleOrchestrator: BubbleOrchestrator;
  windowActivityService: WindowActivityService;
}

export interface ScreenTargetPointOptions {
  startBubble?: string;
  successBubble?: string;
  failureBubble?: string;
  reason?: string;
  monitorScreenAfterPoint?: boolean;
}

const POINTER_KEYWORDS = [
  '指',
  '指出',
  '指给我',
  '指一下',
  '指一指',
  '指给我看',
  '在哪',
  '在哪里',
  '哪里',
  '位置',
  '帮我找',
  '找一下',
  '找一个',
  '哪个按钮',
  '哪个位置',
  '下载在哪',
  '怎么点',
  '点哪里',
  '该点哪',
  '帮我指出',
  '请指出',
  '帮我指',
  '入口',
  '按钮',
  '图标',
  '图案',
  '图片',
  '文字',
  '词条',
  '字样',
  '标志',
  '符号',
  'logo',
  '搜索框',
  '输入框',
  '菜单',
  '链接',
  '选项',
  '标签',
  '下载按钮',
  '安装按钮',
  '官网',
  'where',
  'find',
  'point',
  'show me',
  'which button',
  'where is',
  'where to click',
  'download',
];

const SCREEN_ANALYSIS_ONLY_PATTERNS = [
  /^(描述|总结|分析|识别|看看|看一下|说说|概括)(一下)?(这个)?(屏幕|页面|窗口|画面)?/i,
  /^(屏幕|页面|窗口|画面)(上)?(有|是什么|有什么|内容)/i,
  /^(what|describe|summarize|analyze)\b/i,
];

const TARGET_ONLY_HINTS = [
  '下载',
  '安装',
  '设置',
  '搜索',
  '登录',
  '注册',
  '官网',
  '入口',
  '图标',
  '图案',
  '文字',
  '词条',
  '字样',
  '按钮',
  '链接',
  '菜单',
  '选项',
  '标签',
  'logo',
];

const CONFIDENCE_THRESHOLD = 0.55;
const TENTATIVE_CONFIDENCE_THRESHOLD = 0.35;
const POINT_HOLD_MS = 7000;
const MOVE_SCREEN_MONITOR_MS = 150;
const POST_MOVE_CORRECTION_THRESHOLD_PX = 1.5;
const POST_MOVE_CORRECTION_MIN_IMPROVEMENT_PX = 0.75;
const COMPANION_CAPTURE_HIDE_DELAY_MS = 90;

export class ScreenTargetPointer {
  private mainWindow: BrowserWindow;
  private screenAnalyzer: ScreenAnalyzer;
  private moveController: MoveController;
  private bubbleOrchestrator: BubbleOrchestrator;
  private windowActivityService: WindowActivityService;
  private sessionId = 0;
  private state: ScreenPointingSessionState = 'done';
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private moveMonitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScreenTargetPointerOptions) {
    this.mainWindow = options.mainWindow;
    this.screenAnalyzer = options.screenAnalyzer;
    this.moveController = options.moveController;
    this.bubbleOrchestrator = options.bubbleOrchestrator;
    this.windowActivityService = options.windowActivityService;
  }

  isPointerRequest(message: string): boolean {
    const normalized = this.normalizePointerMessage(message).toLowerCase();
    if (!normalized) return false;
    if (POINTER_KEYWORDS.some(keyword => normalized.includes(keyword.toLowerCase()))) return true;
    return this.isLikelyTargetOnlyRequest(normalized);
  }

  private normalizePointerMessage(message: string): string {
    const trimmed = message.trim();
    return trimmed.startsWith('.') ? trimmed.slice(1).trim() : trimmed;
  }

  private isLikelyTargetOnlyRequest(normalized: string): boolean {
    const compact = normalized.replace(/\s+/g, '');
    if (!compact) return false;
    if (SCREEN_ANALYSIS_ONLY_PATTERNS.some(pattern => pattern.test(normalized))) return false;
    if (/[「『“"'].*[」』”"']/.test(normalized)) return true;
    if (TARGET_ONLY_HINTS.some(hint => normalized.includes(hint.toLowerCase()))) return true;
    return compact.length <= 24 && /[\u4e00-\u9fffA-Za-z0-9]/.test(compact) && !/[？?]/.test(compact);
  }

  async handle(message: string): Promise<ScreenTargetPointerResult> {
    if (!this.isPointerRequest(message)) {
      return { handled: false, moved: false, message: '' };
    }

    return this.pointToTarget(this.normalizePointerMessage(message));
  }

  async pointToTarget(
    targetDescription: string,
    options: ScreenTargetPointOptions = {}
  ): Promise<ScreenTargetPointerResult> {
    const screenMessage = this.normalizePointerMessage(targetDescription);
    if (!screenMessage) {
      return { handled: true, moved: false, message: '' };
    }

    const id = this.startSession();
    const beforeTitle = await this.windowActivityService.getActiveWindowTitle();
    console.log('[ScreenTargetPointer][debug] session start:', {
      sessionId: id,
      message: screenMessage,
      beforeTitle,
      windowBounds: this.mainWindow.getBounds(),
    });
    this.showBubble(options.startBubble || '我看看哦，先别动屏幕~');

    try {
      this.state = 'locating';
      const located = await this.locateTargetWithoutCompanionOverlay(screenMessage);
      console.log('[ScreenTargetPointer][debug] located:', {
        sessionId: id,
        frame: {
          origin: located.frame.origin,
          screenSize: located.frame.screenSize,
          imageSize: located.frame.imageSize,
        },
        result: located.result,
      });
      if (!this.isCurrent(id)) {
        return this.cancelledResult('new-request');
      }

      const afterLocateTitle = await this.windowActivityService.getActiveWindowTitle();
      if (this.hasScreenChanged(beforeTitle, afterLocateTitle)) {
        console.log('[ScreenTargetPointer][debug] screen changed after locate:', { sessionId: id, beforeTitle, afterLocateTitle });
        return this.cancelWithMessage('screen-changed');
      }

      const result = located.result;
      if (!this.canMove(result)) {
        const failureMessage = options.failureBubble || this.failureMessage(screenMessage, result);
        this.showBubble(failureMessage);
        this.finishSession();
        return { handled: true, moved: false, message: failureMessage, locateResult: result };
      }

      const fingerprintChanged = await this.hasFingerprintChangedBeforeMove(id, located.frame);
      if (!this.isCurrent(id)) {
        return this.cancelledResult('new-request');
      }
      if (fingerprintChanged) {
        console.log('[ScreenTargetPointer][debug] screen changed before move:', { sessionId: id });
        return this.screenChangedResult(result);
      }

      const screenPoint = this.screenAnalyzer.mapPointToScreen(located.frame, result.point!);
      const pose = this.choosePose(screenPoint);
      const moveTopLeft = pose.clampedTopLeft;
      console.log('[ScreenTargetPointer][debug] move target:', {
        sessionId: id,
        screenPoint,
        pose,
        moveTopLeft,
        windowBounds: this.mainWindow.getBounds(),
      });

      this.state = 'moving';
      let screenChangedDuringMove = false;
      this.startMoveScreenMonitor(id, beforeTitle, () => {
        screenChangedDuringMove = true;
        this.moveController.cancel('manual');
      });
      let moveResult = await this.moveController.moveTo({
        x: moveTopLeft.x,
        y: moveTopLeft.y,
        anchor: 'top-left',
        reason: options.reason || 'screen-target-pointer',
        speedPxPerSec: 520,
      });

      if (!this.isCurrent(id)) {
        this.clearMoveMonitor();
        return this.cancelledResult('new-request');
      }

      if (!moveResult.cancelled) {
        moveResult = await this.correctPointerAlignmentIfNeeded(id, screenPoint, pose, moveResult);
      }

      this.clearMoveMonitor();

      const afterMoveTitle = await this.windowActivityService.getActiveWindowTitle();
      if (screenChangedDuringMove || this.hasScreenChanged(beforeTitle, afterMoveTitle)) {
        console.log('[ScreenTargetPointer][debug] screen changed after move:', {
          sessionId: id,
          beforeTitle,
          afterMoveTitle,
          screenChangedDuringMove,
          moveResult,
        });
        return this.screenChangedResult(result);
      }

      console.log('[ScreenTargetPointer][debug] move finished:', { sessionId: id, moveResult, afterMoveTitle });

      if (moveResult.cancelled) {
        const messageText = '好啦好啦，我不挡你~';
        this.clearPointVisual();
        this.finishSession();
        this.showBubble(messageText);
        return { handled: true, moved: false, message: messageText, locateResult: result, cancelReason: 'manual' };
      }

      this.state = 'pointing';
      this.sendPointVisual({ active: true, pose: pose.pose, reason: options.reason || 'screen-target-pointer' });
      const successMessage = options.successBubble || this.successMessage(result);
      this.showBubble(successMessage);
      if (options.monitorScreenAfterPoint !== false) {
        this.startPointScreenMonitor(id, beforeTitle);
      }
      this.schedulePointClear(id);
      return { handled: true, moved: true, message: successMessage, locateResult: result };
    } catch (error: any) {
      const messageText = '我没太看清楚。你把页面停在目标附近，再让我看一次吧。';
      console.error('[ScreenTargetPointer] 指示失败:', error?.message || error);
      this.clearPointVisual();
      this.finishSession();
      this.showBubble(messageText);
      return { handled: true, moved: false, message: messageText };
    }
  }

  cancel(reason: ScreenTargetPointerCancelReason = 'manual'): void {
    if (this.state === 'done' || this.state === 'cancelled') return;
    console.log('[ScreenTargetPointer][debug] cancel:', { sessionId: this.sessionId, state: this.state, reason });
    this.sessionId++;
    this.state = 'cancelled';
    this.moveController.cancel('manual');
    this.clearPointVisual();
    this.clearHoldTimer();
    this.clearMoveMonitor();
    if (reason === 'screen-changed') {
      this.showBubble(this.screenChangedMessage());
    } else if (reason === 'drag-start') {
      this.showBubble('好啦好啦，我不挡你~');
    }
  }

  private startSession(): number {
    this.cancel('new-request');
    this.sessionId++;
    this.state = 'capturing';
    return this.sessionId;
  }

  private finishSession(): void {
    this.state = 'done';
    this.clearHoldTimer();
    this.clearMoveMonitor();
  }

  private isCurrent(id: number): boolean {
    return id === this.sessionId && this.state !== 'cancelled';
  }

  private canMove(result: ScreenTargetLocateResult): boolean {
    return result.found === true
      && Number.isFinite(result.confidence)
      && result.confidence >= TENTATIVE_CONFIDENCE_THRESHOLD
      && !!result.point
      && Number.isFinite(result.point.x)
      && Number.isFinite(result.point.y);
  }

  private async locateTargetWithoutCompanionOverlay(screenMessage: string) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return this.screenAnalyzer.locateTarget(screenMessage);
    }

    const previousOpacity = this.mainWindow.getOpacity();
    let cleanFrame: ScreenCaptureFrame | null = null;
    try {
      this.mainWindow.setOpacity(0);
      await delay(COMPANION_CAPTURE_HIDE_DELAY_MS);
      cleanFrame = await this.screenAnalyzer.captureScreenFrame({ highPrecision: true });
    } catch (error: any) {
      console.warn('[ScreenTargetPointer] clean capture failed, falling back to normal capture:', error?.message || error);
    } finally {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.setOpacity(previousOpacity);
      }
    }

    return cleanFrame
      ? this.screenAnalyzer.locateTarget(screenMessage, cleanFrame)
      : this.screenAnalyzer.locateTarget(screenMessage);
  }

  private choosePose(screenPoint: { x: number; y: number }): PointerPoseCandidate {
    const bounds = this.mainWindow.getBounds();
    const windowCenterX = bounds.x + bounds.width / 2;
    const windowCenterY = bounds.y + bounds.height / 2;
    const dx = screenPoint.x - windowCenterX;
    const dy = screenPoint.y - windowCenterY;
    const pose = resolvePointerPoseCandidate(screenPoint, bounds, {
      clampTopLeft: (topLeft, windowSize) => this.clampWindowTopLeft(topLeft, windowSize),
    });

    console.log('[ScreenTargetPointer][debug] choose pose:', {
      screenPoint,
      windowBounds: bounds,
      windowCenter: { x: windowCenterX, y: windowCenterY },
      delta: { x: dx, y: dy },
      angleDegrees: Number.isFinite(dx) && Number.isFinite(dy) ? Math.atan2(dy, dx) * 180 / Math.PI : null,
      pose,
    });

    return pose;
  }

  private async correctPointerAlignmentIfNeeded(
    sessionId: number,
    screenPoint: { x: number; y: number },
    pose: PointerPoseCandidate,
    moveResult: MoveResult
  ): Promise<MoveResult> {
    if (!this.isCurrent(sessionId) || moveResult.cancelled) return moveResult;

    const currentTopLeft = moveResult.finalPosition;
    const currentFinger = {
      x: currentTopLeft.x + pose.pointerOffset.x,
      y: currentTopLeft.y + pose.pointerOffset.y,
    };
    const currentErrorPx = this.distance(currentFinger, screenPoint);
    if (currentErrorPx <= POST_MOVE_CORRECTION_THRESHOLD_PX) {
      return moveResult;
    }

    const desiredTopLeft = {
      x: currentTopLeft.x + screenPoint.x - currentFinger.x,
      y: currentTopLeft.y + screenPoint.y - currentFinger.y,
    };
    const bounds = this.mainWindow.getBounds();
    const correctedTopLeft = this.clampWindowTopLeft(desiredTopLeft, bounds);
    const correctedFinger = {
      x: correctedTopLeft.x + pose.pointerOffset.x,
      y: correctedTopLeft.y + pose.pointerOffset.y,
    };
    const correctedErrorPx = this.distance(correctedFinger, screenPoint);
    const improvementPx = currentErrorPx - correctedErrorPx;
    const correctionDistancePx = this.distance(currentTopLeft, correctedTopLeft);

    if (
      correctionDistancePx < 1 ||
      improvementPx < POST_MOVE_CORRECTION_MIN_IMPROVEMENT_PX ||
      correctedErrorPx >= currentErrorPx
    ) {
      console.log('[ScreenTargetPointer][debug] skip pointer correction:', {
        sessionId,
        currentTopLeft,
        currentFinger,
        currentErrorPx,
        correctedTopLeft,
        correctedFinger,
        correctedErrorPx,
        improvementPx,
      });
      return moveResult;
    }

    console.log('[ScreenTargetPointer][debug] pointer correction:', {
      sessionId,
      currentTopLeft,
      currentFinger,
      currentErrorPx,
      correctedTopLeft,
      correctedFinger,
      correctedErrorPx,
      improvementPx,
    });

    return this.moveController.moveTo({
      x: correctedTopLeft.x,
      y: correctedTopLeft.y,
      anchor: 'top-left',
      reason: 'screen-target-pointer-correction',
      durationMs: 160,
    });
  }

  private clampWindowTopLeft(
    topLeft: { x: number; y: number },
    windowBounds: { width: number; height: number }
  ): { x: number; y: number } {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
    });
    const workArea = display.workArea;
    const minX = workArea.x;
    const minY = workArea.y;
    const maxX = Math.max(minX, workArea.x + workArea.width - windowBounds.width);
    const maxY = Math.max(minY, workArea.y + workArea.height - windowBounds.height);
    return {
      x: Math.round(Math.min(maxX, Math.max(minX, topLeft.x))),
      y: Math.round(Math.min(maxY, Math.max(minY, topLeft.y))),
    };
  }

  private distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private hasScreenChanged(beforeTitle: string, afterTitle: string): boolean {
    if (!beforeTitle || !afterTitle) return false;
    return beforeTitle !== afterTitle;
  }

  private async hasFingerprintChangedBeforeMove(sessionId: number, beforeFrame: ScreenCaptureFrame): Promise<boolean> {
    if (!beforeFrame.fingerprint) {
      console.log('[ScreenTargetPointer][debug] fingerprint skip: missing before fingerprint', { sessionId });
      return false;
    }

    const afterFrame = await this.screenAnalyzer.captureScreenFrame();
    if (!afterFrame?.fingerprint) {
      console.log('[ScreenTargetPointer][debug] fingerprint skip: missing after fingerprint', { sessionId });
      return false;
    }

    const diff = compareScreenFingerprints(beforeFrame.fingerprint, afterFrame.fingerprint);
    if (diff === null) {
      console.log('[ScreenTargetPointer][debug] fingerprint skip: incomparable fingerprints', {
        sessionId,
        before: { width: beforeFrame.fingerprint.width, height: beforeFrame.fingerprint.height, values: beforeFrame.fingerprint.values.length },
        after: { width: afterFrame.fingerprint.width, height: afterFrame.fingerprint.height, values: afterFrame.fingerprint.values.length },
      });
      return false;
    }

    const changed = diff >= SCREEN_FINGERPRINT_CHANGE_THRESHOLD;
    console.log('[ScreenTargetPointer][debug] fingerprint diff before move:', {
      sessionId,
      diff,
      threshold: SCREEN_FINGERPRINT_CHANGE_THRESHOLD,
      changed,
    });
    return changed;
  }

  private successMessage(result: ScreenTargetLocateResult): string {
    const label = result.label || '目标';
    if (result.confidence >= 0.9) return `这里是「${label}」。`;
    if (result.confidence >= CONFIDENCE_THRESHOLD) return `我觉得是这里，你看看是不是「${label}」。`;
    return `我先指最像的位置：可能是「${label}」。`;
  }

  private failureMessage(message: string, result: ScreenTargetLocateResult): string {
    const label = result.label || this.extractTargetHint(message);
    if (result.point && result.confidence > 0 && result.confidence < TENTATIVE_CONFIDENCE_THRESHOLD) {
      return `我看到了很弱的候选，但还不够稳。你可以把「${label}」附近放大一点或停在屏幕中央。`;
    }
    return `我这次没识别到「${label}」的可指位置。你可以把页面停在目标附近，或直接说按钮/文字上的几个字。`;
  }

  private extractTargetHint(message: string): string {
    return message
      .replace(/[。！？!?.]/g, '')
      .replace(/帮我/g, '')
      .replace(/请/g, '')
      .replace(/指出/g, '')
      .replace(/指一下/g, '')
      .replace(/在哪里/g, '')
      .replace(/在哪/g, '')
      .trim()
      .slice(0, 20) || '目标';
  }

  private cancelWithMessage(reason: ScreenTargetPointerCancelReason): ScreenTargetPointerResult {
    this.cancel(reason);
    return { handled: true, moved: false, message: this.screenChangedMessage(), cancelReason: reason };
  }

  private screenChangedResult(result?: ScreenTargetLocateResult): ScreenTargetPointerResult {
    const messageText = this.screenChangedMessage();
    this.clearPointVisual();
    this.finishSession();
    this.showBubble(messageText);
    return { handled: true, moved: false, message: messageText, locateResult: result, cancelReason: 'screen-changed' };
  }

  private cancelledResult(reason: ScreenTargetPointerCancelReason): ScreenTargetPointerResult {
    return { handled: true, moved: false, message: '', cancelReason: reason };
  }

  private screenChangedMessage(): string {
    return '屏幕变了，我刚才看到的位置可能不准啦。你重新发一次「.帮我指出xxx」吧。';
  }

  private showBubble(text: string): void {
    this.bubbleOrchestrator.show({ text, source: 'system', priority: 'high' });
  }

  private sendPointVisual(event: PointVisualEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('point-visual', event);
    }
  }

  private clearPointVisual(): void {
    this.sendPointVisual({ active: false, reason: 'screen-target-pointer' });
  }

  private startMoveScreenMonitor(id: number, beforeTitle: string, onChanged: () => void): void {
    this.startScreenMonitor(id, beforeTitle, 'moving', onChanged);
  }

  private startPointScreenMonitor(id: number, beforeTitle: string): void {
    this.startScreenMonitor(id, beforeTitle, 'pointing', () => {
      this.cancel('screen-changed');
    });
  }

  private startScreenMonitor(
    id: number,
    beforeTitle: string,
    expectedState: ScreenPointingSessionState,
    onChanged: () => void
  ): void {
    this.clearMoveMonitor();
    let polling = false;
    this.moveMonitorTimer = setInterval(() => {
      if (polling || !this.isCurrent(id) || this.state !== expectedState) return;
      polling = true;
      this.windowActivityService.getActiveWindowTitle()
        .then(currentTitle => {
          if (this.isCurrent(id) && this.state === expectedState && this.hasScreenChanged(beforeTitle, currentTitle)) {
            console.log('[ScreenTargetPointer][debug] screen monitor changed:', {
              sessionId: id,
              expectedState,
              beforeTitle,
              currentTitle,
            });
            onChanged();
            this.clearMoveMonitor();
          }
        })
        .catch(error => {
          console.error('[ScreenTargetPointer] 监控活动窗口失败:', error?.message || error);
        })
        .finally(() => {
          polling = false;
        });
    }, MOVE_SCREEN_MONITOR_MS);
  }

  private clearMoveMonitor(): void {
    if (this.moveMonitorTimer) {
      clearInterval(this.moveMonitorTimer);
      this.moveMonitorTimer = null;
    }
  }

  private schedulePointClear(id: number): void {
    this.clearHoldTimer();
    this.holdTimer = setTimeout(() => {
      if (!this.isCurrent(id)) return;
      this.clearPointVisual();
      this.finishSession();
    }, POINT_HOLD_MS);
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
