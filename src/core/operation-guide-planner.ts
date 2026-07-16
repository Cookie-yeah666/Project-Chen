import { ChatMessage } from './ai-service';
import { OperationGuideConfig, OperationGuideConfigManager } from './operation-guide-config';
import {
  OperationGuideAction,
  OperationGuidePlan,
  OperationGuideSource,
  OperationGuideStep,
} from './operation-guide-types';

const PLAN_TIMEOUT_MS = 18000;
const MAX_STEPS = 12;

const ACTIONS: OperationGuideAction[] = ['click', 'scroll', 'input', 'wait', 'open', 'confirm'];

export class OperationGuidePlanner {
  constructor(private configManager: OperationGuideConfigManager) {}

  async buildPlan(softwareName: string, sources: OperationGuideSource[]): Promise<OperationGuidePlan> {
    if (!this.configManager.isPlannerConfigured()) {
      return buildFallbackPlan(softwareName, sources);
    }

    try {
      const config = this.configManager.get();
      const response = await withTimeout(
        callGuidePlannerAPI(this.buildMessages(softwareName, sources, config), config),
        PLAN_TIMEOUT_MS,
        '教程解析超时'
      );
      const parsed = parseGuidePlan(response, softwareName);
      if (parsed.steps.length > 0) return parsed;
    } catch (error: any) {
      console.warn('[OperationGuidePlanner] AI plan failed, fallback to generic plan:', error?.message || error);
    }
    return buildFallbackPlan(softwareName, sources);
  }

  private buildMessages(
    softwareName: string,
    sources: OperationGuideSource[],
    config: OperationGuideConfig
  ): ChatMessage[] {
    const sourceText = sources.length > 0
      ? sources.map((source, index) => [
          `Source ${index + 1}: ${source.title}`,
          `URL: ${source.url}`,
          `Snippet: ${source.snippet}`,
        ].join('\n')).join('\n\n')
      : 'No reliable search result was retrieved. Build a conservative Windows installation guide.';

    return [
      {
        role: 'system',
        content: config.systemPrompt || [
          '你是一个面向电脑零基础用户的屏幕分步操作引导规划器。',
          '你会把搜索结果整理成 Windows 软件下载安装/配置流程。',
          '只返回 JSON，不要 Markdown，不要解释。',
          '每一步只能包含一个用户动作和一个唯一目标控件。',
          'instruction 必须是非常短的中文口语提示，例如“点击右上角的安装 Steam”。',
          'target 必须描述屏幕上可见的按钮、链接、输入框、菜单项或安装器控件，方便视觉模型定位。',
          '如果搜索结果里有可信官网 URL，把 URL 放进第一步 instruction，方便用户点击复制到浏览器。',
          '下载步骤的 target 必须包含可见文字候选，例如 Download / 下载 / Get / Install / Windows / Client / 官方下载。',
          'Allowed action values: click, scroll, input, wait, open, confirm.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Software: ${softwareName}`,
          sourceText,
          'Return this exact JSON shape:',
          '{"softwareName":"...","sourceSummary":"...","steps":[{"id":"step-1","action":"click","target":"Download button or 安装按钮","instruction":"点击 Download 或安装按钮。","expectedChange":"进入下载页面或开始下载"}]}',
          'Rules:',
          '- 4 to 10 steps.',
          '- 每一步只给一个动作，不要一次讲多个按钮。',
          '- target must be a visible screen element description suitable for vision localization.',
          '- For download pages, target should include visible text alternatives: Download, 下载, Get, Install, Windows, Client, 官方下载.',
          '- If a reliable official URL is available, include it in instruction so the UI can render it as a click-to-copy URL.',
          '- instruction 必须短，优先使用简单中文。',
          '- 如果需要滚动，单独生成 scroll 步骤。',
          '- 不要生成自动点击、自动输入或后台操作步骤，只指导用户自己操作。',
        ].join('\n\n'),
      },
    ];
  }
}

async function callGuidePlannerAPI(
  messages: ChatMessage[],
  config: OperationGuideConfig
): Promise<string> {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`指引 API 请求失败 (${response.status}): ${error}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content ?? '';
}

export function parseGuidePlan(raw: string, fallbackSoftwareName: string): OperationGuidePlan {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return buildFallbackPlan(fallbackSoftwareName, []);

  const parsed = JSON.parse(match[0]) as any;
  const softwareName = stringOr(parsed.softwareName, fallbackSoftwareName);
  const sourceSummary = stringOr(parsed.sourceSummary, 'AI generated installation guide');
  const rawSteps: any[] = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = rawSteps
    .map((step, index) => sanitizeStep(step, index))
    .filter((step): step is OperationGuideStep => !!step)
    .slice(0, MAX_STEPS);

  return {
    softwareName,
    sourceSummary,
    steps,
  };
}

export function buildFallbackPlan(
  softwareName: string,
  sources: OperationGuideSource[] = []
): OperationGuidePlan {
  const query = `${softwareName} official download`;
  const officialSource = pickBestOfficialSource(softwareName, sources);
  const officialUrl = officialSource?.url || '';
  const steps: OperationGuideStep[] = [
    officialUrl
      ? {
          id: 'step-1',
          action: 'open',
          target: 'browser address bar',
          instruction: `点击复制官网地址 ${officialUrl}，粘到浏览器地址栏打开。`,
          expectedChange: 'Official download page opens',
        }
      : {
          id: 'step-1',
          action: 'open',
          target: 'browser address bar or search box',
          instruction: `打开浏览器，搜索“${query}”。`,
          expectedChange: 'Search results are visible',
        },
    officialUrl
      ? {
          id: 'step-2',
          action: 'click',
          target: `${softwareName} official download page visible Download 下载 Get Install Windows Client button or link`,
          instruction: '在官网页面点击 Download、下载、Windows 或 Client 按钮。',
          expectedChange: 'Installer download starts or download page opens',
        }
      : {
          id: 'step-2',
          action: 'click',
          target: `${softwareName} official website or official download result 官网 官方下载 result`,
          instruction: '点击官网或官方下载结果。',
          expectedChange: 'Official download page opens',
        },
    {
      id: 'step-3',
      action: 'click',
      target: `${softwareName} Download 下载 Get Install Windows Client setup installer button or link`,
      instruction: '点击 Windows 的 Download、下载或安装按钮。',
      expectedChange: 'Installer download starts',
    },
    {
      id: 'step-4',
      action: 'wait',
      target: 'download item or downloaded installer file',
      instruction: '等安装包下载完成，然后打开它。',
      expectedChange: 'Installer window opens',
    },
    {
      id: 'step-5',
      action: 'click',
      target: 'Install 安装 Next 下一步 Continue 继续 Run 运行 button',
      instruction: '点击安装器里的安装、下一步或继续。',
      expectedChange: 'Installation progresses',
    },
    {
      id: 'step-6',
      action: 'confirm',
      target: 'Finish 完成 Open 打开 Launch 启动 button',
      instruction: '安装完成后点击完成、打开或启动。',
      expectedChange: 'Application opens',
    },
  ];

  return {
    softwareName,
    sourceSummary: sources.length > 0
      ? `Fallback guide with ${sources.length} search result(s).`
      : 'Generic Windows installation fallback guide.',
    steps,
  };
}

function pickBestOfficialSource(
  softwareName: string,
  sources: OperationGuideSource[]
): OperationGuideSource | undefined {
  const name = softwareName.toLowerCase().replace(/\s+/g, '');
  const scored = sources
    .filter(source => /^https?:\/\//i.test(source.url || ''))
    .map(source => {
      const text = `${source.title} ${source.url} ${source.snippet}`.toLowerCase();
      const compactText = text.replace(/\s+/g, '');
      let score = 0;
      if (compactText.includes(name)) score += 3;
      if (/official|官网|官方网站/.test(text)) score += 3;
      if (/download|下载|get|install|安装|windows|client/.test(text)) score += 2;
      if (/github\.com|microsoft\.com|apple\.com|store\.steampowered\.com/.test(text)) score += 1;
      if (/blog|forum|reddit|知乎|csdn|bilibili|youtube/.test(text)) score -= 2;
      return { source, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].source : undefined;
}

function sanitizeStep(value: any, index: number): OperationGuideStep | null {
  if (!value || typeof value !== 'object') return null;
  const action = ACTIONS.includes(value.action) ? value.action : 'click';
  const target = stringOr(value.target, '');
  const instruction = stringOr(value.instruction, '');
  if (!target || !instruction) return null;
  return {
    id: stringOr(value.id, `step-${index + 1}`),
    action,
    target,
    instruction,
    expectedChange: stringOr(value.expectedChange, ''),
  };
}

function stringOr(value: any, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
