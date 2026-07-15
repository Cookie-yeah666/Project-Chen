import { BrowserWindow } from 'electron';
import { BubbleOrchestrator } from './bubble-orchestrator';
import { OperationGuideConfigManager } from './operation-guide-config';
import {
  SCREEN_FINGERPRINT_CHANGE_THRESHOLD,
  compareScreenFingerprints,
} from './screen-fingerprint';
import { ScreenAnalyzer, ScreenCaptureFrame } from './screen-analyzer';
import { ScreenTargetPointer } from './screen-target-pointer';
import { OperationGuidePlanner } from './operation-guide-planner';
import { OperationGuideSearchService } from './operation-guide-search';
import {
  OperationGuidePlan,
  OperationGuideSnapshot,
  OperationGuideStatus,
  OperationGuideStep,
} from './operation-guide-types';

interface OperationGuideManagerOptions {
  mainWindow: BrowserWindow;
  configManager: OperationGuideConfigManager;
  screenAnalyzer: ScreenAnalyzer;
  screenTargetPointer: ScreenTargetPointer;
  bubbleOrchestrator: BubbleOrchestrator;
}

const SCREEN_CHANGE_POLL_MS = 1800;
const SCREEN_CHANGE_STABLE_DELAY_MS = 1200;

export class OperationGuideManager {
  private mainWindow: BrowserWindow;
  private screenAnalyzer: ScreenAnalyzer;
  private screenTargetPointer: ScreenTargetPointer;
  private bubbleOrchestrator: BubbleOrchestrator;
  private configManager: OperationGuideConfigManager;
  private searchService = new OperationGuideSearchService();
  private planner: OperationGuidePlanner;
  private plan: OperationGuidePlan | null = null;
  private status: OperationGuideStatus = 'idle';
  private currentIndex = 0;
  private message = '';
  private error = '';
  private sessionId = 0;
  private runningStep = false;
  private screenWatcher: ReturnType<typeof setInterval> | null = null;
  private screenWatcherBase: ScreenCaptureFrame | null = null;

  constructor(options: OperationGuideManagerOptions) {
    this.mainWindow = options.mainWindow;
    this.screenAnalyzer = options.screenAnalyzer;
    this.screenTargetPointer = options.screenTargetPointer;
    this.bubbleOrchestrator = options.bubbleOrchestrator;
    this.configManager = options.configManager;
    this.planner = new OperationGuidePlanner(options.configManager);
  }

  isActive(): boolean {
    return !!this.plan && this.status !== 'idle' && this.status !== 'completed';
  }

  isGuideCommand(message: string): boolean {
    const text = message.trim();
    if (!text) return false;
    if (this.isActive() && /^(下一步|下一个|继续|退出|结束|停止|取消教程|退出教程)$/i.test(text)) return true;
    return this.extractSoftwareName(text).length > 0;
  }

  async handleChatCommand(message: string): Promise<string> {
    const text = message.trim();
    if (/^(退出|结束|停止|取消教程|退出教程)$/i.test(text)) {
      this.exit('已退出当前指引。');
      return '已退出当前指引。';
    }
    if (/^(下一步|下一个|继续)$/i.test(text)) {
      await this.next('manual');
      return this.message || '已进入下一步。';
    }

    const softwareName = this.extractSoftwareName(text);
    if (!softwareName) return '';
    await this.start(softwareName);
    return this.message || `已开始 ${softwareName} 的分步操作指引。`;
  }

  async start(softwareName: string): Promise<void> {
    if (!this.configManager.isEnabled()) {
      this.message = '分步操作指引未启用。请在设置里打开“分步指引”。';
      this.showBubble(this.message);
      this.emitState();
      return;
    }

    const id = this.startSession();
    this.plan = null;
    this.currentIndex = 0;
    this.error = '';
    this.status = 'planning';
    this.message = `正在整理「${softwareName}」的安装步骤...`;
    this.showBubble(this.message);
    this.emitState();

    try {
      const config = this.configManager.get();
      const sources = config.searchEnabled
        ? await this.searchService.searchInstallGuides(softwareName)
        : [];
      if (!this.isCurrent(id)) return;
      this.plan = await this.planner.buildPlan(softwareName, sources);
      if (!this.isCurrent(id)) return;

      if (!this.plan.steps.length) {
        throw new Error('没有生成可执行步骤');
      }

      this.message = `已整理 ${this.plan.steps.length} 步，每次只指一个目标。`;
      this.showBubble(this.message);
      this.emitState();
      await this.runCurrentStep(id, 'start');
    } catch (error: any) {
      if (!this.isCurrent(id)) return;
      this.status = 'error';
      this.error = error?.message || String(error);
      this.message = `指引启动失败：${this.error}`;
      this.showBubble('指引启动失败。你可以换一个更具体的软件名称再试。');
      this.emitState();
    }
  }

  async next(reason: 'manual' | 'screen-changed' = 'manual'): Promise<void> {
    if (!this.plan || this.status === 'completed') return;
    if (this.runningStep) return;
    const id = this.sessionId;
    this.stopScreenWatcher();

    if (this.currentIndex >= this.plan.steps.length - 1) {
      this.complete();
      return;
    }

    this.currentIndex += 1;
    await this.runCurrentStep(id, reason);
  }

  exit(message = '已退出当前指引。'): void {
    this.sessionId++;
    this.stopScreenWatcher();
    this.screenTargetPointer.cancel('manual');
    this.plan = null;
    this.currentIndex = 0;
    this.status = 'idle';
    this.message = message;
    this.error = '';
    this.showBubble(message);
    this.emitState();
  }

  getSnapshot(): OperationGuideSnapshot {
    const step = this.getCurrentStep();
    return {
      active: this.isActive(),
      status: this.status,
      softwareName: this.plan?.softwareName,
      currentIndex: this.plan ? this.currentIndex : 0,
      totalSteps: this.plan?.steps.length ?? 0,
      currentStep: step,
      message: this.message,
      canNext: !!this.plan && (this.status === 'waiting' || this.status === 'error'),
      canExit: this.isActive(),
      error: this.error || undefined,
    };
  }

  private async runCurrentStep(
    sessionId: number,
    reason: 'start' | 'manual' | 'screen-changed'
  ): Promise<void> {
    if (!this.plan || !this.isCurrent(sessionId) || this.runningStep) return;
    const step = this.getCurrentStep();
    if (!step) return;

    this.runningStep = true;
    this.status = 'locating';
    this.message = `第 ${this.currentIndex + 1}/${this.plan.steps.length} 步：${step.instruction}`;
    this.emitState();

    try {
      const targetDescription = this.buildTargetDescription(step);
      const result = await this.screenTargetPointer.pointToTarget(targetDescription, {
        startBubble: reason === 'screen-changed' ? '页面变了，我重新找下一步位置。' : '我来找这一步要点哪里。',
        successBubble: step.instruction,
        failureBubble: `我暂时没在屏幕上找到「${step.target}」。你可以切到相关页面后点“下一步”继续。`,
        reason: 'operation-guide',
        monitorScreenAfterPoint: false,
      });
      if (!this.isCurrent(sessionId)) return;

      this.status = result.moved ? 'waiting' : 'error';
      this.message = result.moved
        ? step.instruction
        : `未找到目标：${step.target}`;
      this.error = result.moved ? '' : 'target-not-found';
      this.emitState();
      await this.startScreenWatcher(sessionId);
    } catch (error: any) {
      if (!this.isCurrent(sessionId)) return;
      this.status = 'error';
      this.error = error?.message || String(error);
      this.message = `这一步识别失败：${this.error}`;
      this.showBubble('这一步我没识别稳。你调整页面后可以点下一步，或者退出教程。');
      this.emitState();
    } finally {
      this.runningStep = false;
    }
  }

  private async startScreenWatcher(sessionId: number): Promise<void> {
    this.stopScreenWatcher();
    const baseFrame = await this.screenAnalyzer.captureScreenFrame();
    if (!this.isCurrent(sessionId) || !baseFrame?.fingerprint) return;
    this.screenWatcherBase = baseFrame;

    this.screenWatcher = setInterval(() => {
      if (!this.isCurrent(sessionId) || this.status !== 'waiting') {
        this.stopScreenWatcher();
        return;
      }

      this.screenAnalyzer.captureScreenFrame()
        .then(frame => {
          if (!this.isCurrent(sessionId) || this.status !== 'waiting') return;
          if (!frame?.fingerprint || !this.screenWatcherBase?.fingerprint) return;
          const diff = compareScreenFingerprints(this.screenWatcherBase.fingerprint, frame.fingerprint);
          if (diff === null || diff < SCREEN_FINGERPRINT_CHANGE_THRESHOLD) return;

          this.stopScreenWatcher();
          setTimeout(() => {
            if (this.isCurrent(sessionId) && this.status === 'waiting') {
              this.next('screen-changed').catch(error => {
                console.error('[OperationGuideManager] auto next failed:', error?.message || error);
              });
            }
          }, SCREEN_CHANGE_STABLE_DELAY_MS);
        })
        .catch(error => {
          console.warn('[OperationGuideManager] screen watcher failed:', error?.message || error);
        });
    }, SCREEN_CHANGE_POLL_MS);
  }

  private stopScreenWatcher(): void {
    if (this.screenWatcher) {
      clearInterval(this.screenWatcher);
      this.screenWatcher = null;
    }
    this.screenWatcherBase = null;
  }

  private complete(): void {
    this.stopScreenWatcher();
    this.status = 'completed';
    this.message = '指引完成。';
    this.showBubble('这套操作指引完成啦。');
    this.emitState();
    this.plan = null;
    this.currentIndex = 0;
  }

  private getCurrentStep(): OperationGuideStep | undefined {
    return this.plan?.steps[this.currentIndex];
  }

  private buildTargetDescription(step: OperationGuideStep): string {
    return [
      `当前操作类型：${step.action}`,
      `目标界面元素：${step.target}`,
      `用户要完成的动作：${step.instruction}`,
      step.expectedChange ? `完成后的界面变化：${step.expectedChange}` : '',
      '请定位当前屏幕上最匹配的唯一目标控件。',
    ].filter(Boolean).join('\n');
  }

  private extractSoftwareName(message: string): string {
    const normalized = message.trim();
    const patterns = [
      /^\/guide\s+(.+)$/i,
      /^#guide\s+(.+)$/i,
      /^开始指引\s*(.+)$/i,
      /^启动指引\s*(.+)$/i,
      /^安装指引\s*(.+)$/i,
      /^帮我安装\s*(.+)$/i,
      /^教我安装\s*(.+)$/i,
      /^引导安装\s*(.+)$/i,
      /^我要安装\s*(.+)$/i,
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) return cleanupSoftwareName(match[1]);
    }
    return '';
  }

  private startSession(): number {
    this.sessionId++;
    this.runningStep = false;
    this.stopScreenWatcher();
    this.screenTargetPointer.cancel('new-request');
    return this.sessionId;
  }

  private isCurrent(id: number): boolean {
    return id === this.sessionId;
  }

  private emitState(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send('guide-state', this.getSnapshot());
  }

  private showBubble(text: string): void {
    this.bubbleOrchestrator.show({ text, source: 'system', priority: 'high' });
  }
}

function cleanupSoftwareName(value: string): string {
  return value
    .replace(/教程|流程|客户端|软件/g, match => match === '客户端' ? match : '')
    .replace(/[。！？!?]$/g, '')
    .trim()
    .slice(0, 80);
}
