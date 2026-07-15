import { JsonConfigStore } from './json-config-store';

export type ASRProvider = 'openai-compatible';
export type ASRProviderPreset = 'openai' | 'aliyun-bailian' | 'custom-openai-compatible';
export type ASRStreamingMode = 'realtime' | 'chunked-fallback';

export interface ASRCacheConfig {
  enabled: boolean;
  retentionMinutes: number;
  maxSessionBytes: number;
}

export interface ASRProviderPresetDefinition {
  id: ASRProviderPreset;
  label: string;
  provider: ASRProvider;
  baseUrl: string;
  model: string;
  realtimePath: string;
  transcriptionPath: string;
  streamingMode: ASRStreamingMode;
  language: string;
  note: string;
}

export interface ASRConfig {
  enabled: boolean;
  providerPreset: ASRProviderPreset;
  provider: ASRProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  realtimePath: string;
  transcriptionPath: string;
  streamingMode: ASRStreamingMode;
  language: string;
  autoSendFinalTranscript: boolean;
  holdToTalkShortcut: string;
  cache: ASRCacheConfig;
}


export const ASR_PROVIDER_PRESETS: Record<ASRProviderPreset, ASRProviderPresetDefinition> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe',
    realtimePath: '/realtime',
    transcriptionPath: '/audio/transcriptions',
    streamingMode: 'realtime',
    language: 'zh',
    note: 'OpenAI 官方语音识别接口，使用当前 OpenAI-compatible ASR 引擎。',
  },
  'aliyun-bailian': {
    id: 'aliyun-bailian',
    label: '阿里百炼 / DashScope',
    provider: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: '',
    realtimePath: '/realtime',
    transcriptionPath: '/audio/transcriptions',
    streamingMode: 'chunked-fallback',
    language: 'zh',
    note: '阿里百炼预设复用 OpenAI-compatible ASR 引擎；请填写 DashScope API Key 和兼容 ASR 模型。若所选模型不支持当前路径，请改用自定义路径或后续添加专用 provider engine。',
  },
  'custom-openai-compatible': {
    id: 'custom-openai-compatible',
    label: '自定义 OpenAI-compatible',
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    realtimePath: '/realtime',
    transcriptionPath: '/audio/transcriptions',
    streamingMode: 'chunked-fallback',
    language: 'zh',
    note: '用于兼容 OpenAI audio/transcriptions 或 realtime 风格接口的第三方服务；Base URL、路径和模型由用户维护。',
  },
};

export function applyASRProviderPreset(config: ASRConfig, preset: ASRProviderPreset): ASRConfig {
  const definition = ASR_PROVIDER_PRESETS[preset];
  return {
    ...config,
    providerPreset: definition.id,
    provider: definition.provider,
    baseUrl: definition.baseUrl,
    model: definition.model,
    realtimePath: definition.realtimePath,
    transcriptionPath: definition.transcriptionPath,
    streamingMode: definition.streamingMode,
    language: definition.language,
    apiKey: config.apiKey,
    enabled: config.enabled,
    autoSendFinalTranscript: config.autoSendFinalTranscript,
    holdToTalkShortcut: config.holdToTalkShortcut,
    cache: config.cache,
  };
}

export const DEFAULT_ASR_CONFIG: ASRConfig = {
  enabled: false,
  providerPreset: 'openai',
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini-transcribe',
  realtimePath: '/realtime',
  transcriptionPath: '/audio/transcriptions',
  streamingMode: 'realtime',
  language: 'zh',
  autoSendFinalTranscript: false,
  holdToTalkShortcut: 'Ctrl+Shift+Space',
  cache: {
    enabled: true,
    retentionMinutes: 30,
    maxSessionBytes: 10 * 1024 * 1024,
  },
};

export class ASRConfigManager {
  private store: JsonConfigStore<ASRConfig>;

  constructor() {
    this.store = new JsonConfigStore<ASRConfig>({
      fileName: 'asr.json',
      defaults: DEFAULT_ASR_CONFIG,
      namespace: 'ASRConfig',
    });
  }

  get(): ASRConfig {
    return this.store.get();
  }

  update(partial: Partial<ASRConfig>): void {
    this.store.update(partial);
  }

  save(): void {
    this.store.save();
  }
}
