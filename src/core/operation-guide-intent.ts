export type OperationGuideControlCommand = 'next' | 'reidentify' | 'exit';

const GUIDE_PREFIX_PATTERN = /^[.。]\s*/;

export function getOperationGuideControlCommand(message: string): OperationGuideControlCommand | null {
  const text = normalizeIntentText(message);
  if (!text) return null;

  if (/^(退出|结束|停止|取消教程|退出教程|关闭指引|不引导了)$/i.test(text)) return 'exit';
  if (/^(重新识别|重新定位|重新指一下|再看一眼|再指一次|没指准|不准)$/i.test(text)) return 'reidentify';
  if (/^(下一步|下一个|继续|我完成了|完成了|已完成|做完了|点完了|我点完了)$/i.test(text)) return 'next';

  return null;
}

export function extractOperationGuideSoftwareName(message: string): string {
  const normalized = normalizeIntentText(message);
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
    /^(?:我想|我要|想|要)?(?:下载|安装|设置|配置|注册|登录)\s*([^，,。！？!?]+?)(?:\s*[，,。！？!?]?\s*(?:下一步|怎么|如何|教程|流程).*)?$/i,
    /^(?:帮我|教我|引导我|带我)(?:下载|安装|设置|配置|注册|登录)\s*([^，,。！？!?]+?)(?:\s*[，,。！？!?]?\s*(?:下一步|怎么|如何|教程|流程).*)?$/i,
    /^怎么(?:下载|安装|设置|配置|注册|登录)\s*([^，,。！？!?]+?)(?:\s*[，,。！？!?]?\s*(?:下一步|怎么|如何|教程|流程).*)?$/i,
    /^(.+?)(?:怎么|如何)(?:下载|安装|设置|配置|注册|登录)(?:\s*[，,。！？!?]?\s*(?:下一步|教程|流程).*)?$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return cleanupOperationGuideSoftwareName(match[1]);
  }

  return '';
}

function normalizeIntentText(message: string): string {
  return message
    .trim()
    .replace(GUIDE_PREFIX_PATTERN, '')
    .replace(/[。！？!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

function cleanupOperationGuideSoftwareName(value: string): string {
  return value
    .replace(/^(一下|一下子|这个|那个|这个软件|那个软件)\s*/g, '')
    .replace(/教程|流程|软件/g, '')
    .replace(/[。！？!?，,]$/g, '')
    .trim()
    .slice(0, 80);
}
