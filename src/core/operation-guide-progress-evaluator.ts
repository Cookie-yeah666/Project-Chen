import { ScreenAnalyzer } from './screen-analyzer';
import { OperationGuideStep } from './operation-guide-types';

export interface OperationGuideProgressEvaluation {
  completed: boolean;
  confidence: number;
  currentStage: string;
  nextTargetVisible: boolean;
  reason: string;
}

interface EvaluateProgressInput {
  softwareName: string;
  currentStep: OperationGuideStep;
  nextStep?: OperationGuideStep;
}

const PROGRESS_EVALUATION_TIMEOUT_MS = 4500;
const PROGRESS_EVALUATION_MAX_TOKENS = 220;

export class OperationGuideProgressEvaluator {
  constructor(private screenAnalyzer: ScreenAnalyzer) {}

  async evaluate(input: EvaluateProgressInput): Promise<OperationGuideProgressEvaluation> {
    const response = await this.screenAnalyzer.queryScreen(this.buildPrompt(input), {
      highPrecision: false,
      visionImageDetail: 'low',
      visionSystemPrompt: '你是屏幕流程状态判断助手，只能输出 JSON，不要输出 Markdown。',
      visionRequestTimeoutMs: PROGRESS_EVALUATION_TIMEOUT_MS,
      visionMaxTokens: PROGRESS_EVALUATION_MAX_TOKENS,
    });

    return parseProgressEvaluation(response.text);
  }

  private buildPrompt(input: EvaluateProgressInput): string {
    const current = input.currentStep;
    const next = input.nextStep;
    return [
      '请判断用户在当前屏幕上是否已经完成了当前分步指引步骤。',
      `软件目标：${input.softwareName}`,
      `当前步骤动作：${current.action}`,
      `当前步骤目标控件：${current.target}`,
      `当前步骤提示：${current.instruction}`,
      current.expectedChange ? `完成当前步骤后通常会出现的变化：${current.expectedChange}` : '',
      next ? `下一步目标控件：${next.target}` : '',
      next ? `下一步提示：${next.instruction}` : '',
      '判断规则：',
      '- 只根据当前截图判断，不要猜测用户以前做过什么。',
      '- 如果当前步骤目标仍然只是刚出现、还需要用户输入/点击，completed=false。',
      '- 如果已经出现下一步目标、搜索结果页、下载页、安装器下一页、确认弹窗等，通常 completed=true。',
      '- 如果不确定，completed=false，confidence 不要超过 0.7。',
      '- currentStage 用一句很短的中文说明用户当前大概在哪个界面。',
      '只输出 JSON：',
      '{"completed":false,"confidence":0.62,"currentStage":"浏览器搜索框已打开","nextTargetVisible":false,"reason":"搜索词还没有提交"}',
    ].filter(Boolean).join('\n');
  }
}

export function parseProgressEvaluation(raw: string): OperationGuideProgressEvaluation {
  const fallback: OperationGuideProgressEvaluation = {
    completed: false,
    confidence: 0,
    currentStage: '',
    nextTargetVisible: false,
    reason: '未返回可解析的进度判断',
  };

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as any;
    return {
      completed: parsed.completed === true,
      confidence: clamp01(Number(parsed.confidence)),
      currentStage: stringOr(parsed.currentStage, ''),
      nextTargetVisible: parsed.nextTargetVisible === true,
      reason: stringOr(parsed.reason, ''),
    };
  } catch (error: any) {
    return {
      ...fallback,
      reason: error?.message || fallback.reason,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function stringOr(value: any, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

