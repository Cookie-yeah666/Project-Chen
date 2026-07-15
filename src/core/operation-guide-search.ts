import { OperationGuideSource } from './operation-guide-types';

const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;

export class OperationGuideSearchService {
  async searchInstallGuides(softwareName: string): Promise<OperationGuideSource[]> {
    const query = `${softwareName} official download install guide Windows`;
    const sources = await Promise.allSettled([
      this.searchDuckDuckGo(query),
      this.searchJina(query),
    ]);

    const merged = sources
      .flatMap(result => result.status === 'fulfilled' ? result.value : [])
      .filter(source => source.title || source.snippet || source.url);
    return dedupeSources(merged).slice(0, MAX_RESULTS);
  }

  private async searchDuckDuckGo(query: string): Promise<OperationGuideSource[]> {
    const html = await fetchTextWithTimeout(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      SEARCH_TIMEOUT_MS
    );
    const results: OperationGuideSource[] = [];
    const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;
    while ((match = resultPattern.exec(html)) && results.length < MAX_RESULTS) {
      results.push({
        title: cleanHtml(match[2]),
        url: normalizeDuckDuckGoUrl(match[1]),
        snippet: cleanHtml(match[3]),
      });
    }
    return results;
  }

  private async searchJina(query: string): Promise<OperationGuideSource[]> {
    const text = await fetchTextWithTimeout(`https://s.jina.ai/${encodeURIComponent(query)}`, SEARCH_TIMEOUT_MS);
    const blocks = text.split(/\n(?=Title: )/).slice(0, MAX_RESULTS);
    return blocks.map(block => {
      const title = firstMatch(block, /^Title:\s*(.+)$/m);
      const url = firstMatch(block, /^URL Source:\s*(.+)$/m) || firstMatch(block, /^Url:\s*(.+)$/m);
      const snippet = firstMatch(block, /^Description:\s*(.+)$/m) || block.split('\n').slice(0, 4).join(' ');
      return {
        title: title || '',
        url: url || '',
        snippet: snippet || '',
      };
    }).filter(source => source.title || source.snippet || source.url);
  }
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Project-Ze-OperationGuide/1.0',
      },
    });
    if (!response.ok) throw new Error(`search failed (${response.status})`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function cleanHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeDuckDuckGoUrl(url: string): string {
  const decoded = decodeHtmlEntities(url);
  try {
    const parsed = new URL(decoded, 'https://duckduckgo.com');
    const redirect = parsed.searchParams.get('uddg');
    return redirect ? decodeURIComponent(redirect) : parsed.toString();
  } catch {
    return decoded;
  }
}

function firstMatch(text: string, pattern: RegExp): string {
  return pattern.exec(text)?.[1]?.trim() ?? '';
}

function dedupeSources(sources: OperationGuideSource[]): OperationGuideSource[] {
  const seen = new Set<string>();
  const result: OperationGuideSource[] = [];
  for (const source of sources) {
    const key = (source.url || source.title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}
