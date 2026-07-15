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
          'You turn messy web search results into a short Windows installation guide.',
          'Return JSON only. No Markdown.',
          'Every step must describe exactly one user action target.',
          'Allowed action values: click, scroll, input, wait, open, confirm.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Software: ${softwareName}`,
          sourceText,
          'Return this exact JSON shape:',
          '{"softwareName":"...","sourceSummary":"...","steps":[{"id":"step-1","action":"click","target":"Download button","instruction":"Click the Download button.","expectedChange":"Download page opens"}]}',
          'Rules:',
          '- 4 to 10 steps.',
          '- target must be a visible screen element description suitable for vision localization.',
          '- instruction must be short and clear for a computer beginner.',
          '- include scrolling/input/wait steps only when useful.',
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
  const steps: OperationGuideStep[] = [
    {
      id: 'step-1',
      action: 'open',
      target: 'browser address bar or search box',
      instruction: `Open a browser and search for "${query}".`,
      expectedChange: 'Search results are visible',
    },
    {
      id: 'step-2',
      action: 'click',
      target: `${softwareName} official website or official download result`,
      instruction: 'Click the official website or official download result.',
      expectedChange: 'Official download page opens',
    },
    {
      id: 'step-3',
      action: 'click',
      target: 'Download button or Windows download link',
      instruction: 'Click the Download button for Windows.',
      expectedChange: 'Installer download starts',
    },
    {
      id: 'step-4',
      action: 'wait',
      target: 'download item or downloaded installer file',
      instruction: 'Wait for the installer download to finish, then open it.',
      expectedChange: 'Installer window opens',
    },
    {
      id: 'step-5',
      action: 'click',
      target: 'Install Next Continue or Run button',
      instruction: 'Click the install confirmation button.',
      expectedChange: 'Installation progresses',
    },
    {
      id: 'step-6',
      action: 'confirm',
      target: 'Finish Open or Launch button',
      instruction: 'Click Finish, Open, or Launch when installation completes.',
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
