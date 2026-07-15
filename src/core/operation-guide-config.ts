import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface OperationGuideConfig {
  enabled: boolean;
  searchEnabled: boolean;
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  lastTargetSoftware: string;
}

const DEFAULT_CONFIG: OperationGuideConfig = {
  enabled: false,
  searchEnabled: true,
  apiKey: '',
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 1200,
  lastTargetSoftware: '',
  systemPrompt: [
    '你是分步操作指引规划助手。',
    '你的任务是把软件下载、安装、配置流程整理成适合电脑新手执行的单步操作队列。',
    '每一步只能包含一个操作目标，目标必须是屏幕上可定位的按钮、链接、输入框、菜单项或明显 UI 区域。',
    '只输出 JSON，不要输出 Markdown。',
  ].join('\n'),
};

export class OperationGuideConfigManager {
  private configPath: string;
  private config: OperationGuideConfig;

  constructor() {
    const configDir = path.join(app.getPath('userData'), 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    this.configPath = path.join(configDir, 'operation-guide-config.json');
    this.config = this.load();
  }

  private load(): OperationGuideConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      }
    } catch (error) {
      console.error('[OperationGuideConfig] 加载配置失败:', error);
    }
    return { ...DEFAULT_CONFIG };
  }

  get(): OperationGuideConfig {
    return this.config;
  }

  update(partial: Partial<OperationGuideConfig>): OperationGuideConfig {
    this.config = { ...this.config, ...partial };
    this.save();
    return this.config;
  }

  save(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      console.error('[OperationGuideConfig] 保存配置失败:', error);
    }
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  isPlannerConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.baseURL && this.config.model);
  }
}
