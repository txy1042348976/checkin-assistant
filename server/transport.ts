import got from 'got';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpError } from './errors.js';
import { proxyAgentUrl, resolveProxy } from './proxy.js';
import type { ResolvedProxy } from './proxy.js';
import type { AppConfig, Provider, ProxyConfig } from './types.js';

export interface HttpResponse { status: number; headers: Record<string, string>; body: unknown; text: string }
export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  provider?: Provider;
  proxy?: ResolvedProxy | ProxyConfig | null;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  config?: AppConfig;
}

export class TransportError extends Error {
  kind: 'timeout' | 'network' | 'limit' | 'aborted';
  constructor(kind: TransportError['kind']) {
    super(kind === 'timeout' ? '站点请求超时。' : kind === 'limit' ? '站点响应超过允许大小。' : kind === 'aborted' ? '站点请求已取消。' : '无法连接站点，请检查服务器网络或账号代理。');
    this.name = 'TransportError'; this.kind = kind;
  }
}

export function isJsonContentType(value: string | undefined): boolean { return /application\/(?:[\w.-]+\+)?json\b/i.test(value ?? ''); }
export function guardedResponse(response: Pick<HttpResponse, 'headers' | 'text'>): boolean {
  return /text\/html/i.test(response.headers['content-type'] ?? '') || /aliyun_waf|滑动验证|访问验证/.test(response.text.slice(0, 4000));
}

export function safeRequestUrl(value: string, provider?: Pick<Provider, 'domain'>): URL {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new HttpError(422, '站点请求网址无效。');
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(422, '站点请求网址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash
      || (provider && url.origin !== new URL(provider.domain).origin)) throw new HttpError(422, '站点请求必须保持在当前站点。');
  return url;
}

export async function httpRequest(urlValue: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const url = safeRequestUrl(urlValue, options.provider);
  const method = (options.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new HttpError(422, '站点请求方式无效。');
  const timeoutMs = options.timeoutMs ?? 20000, maxBytes = options.maxBytes ?? 262144;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
    throw new HttpError(422, '站点请求限制配置无效。');
  }
  const headers: Record<string, string> = { accept: 'application/json', 'cache-control': 'no-cache' };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || typeof value !== 'string' || /[^\x20-\x7e]/.test(value)
        || ['host', 'content-length', 'connection', 'proxy-authorization'].includes(name.toLowerCase())) throw new HttpError(422, '站点请求头格式无效。');
    headers[name.toLowerCase()] = value;
  }
  if (options.json !== undefined && (method === 'GET' || method === 'HEAD')) throw new HttpError(422, '只读站点请求不能包含提交数据。');
  const proxy = resolveProxy(options.provider, options.proxy, options.config);
  const agent = proxy ? proxy.server.startsWith('socks5:')
    ? { http: new SocksProxyAgent(proxyAgentUrl(proxy)), https: new SocksProxyAgent(proxyAgentUrl(proxy)) }
    : { http: new HttpProxyAgent(proxyAgentUrl(proxy)), https: new HttpsProxyAgent(proxyAgentUrl(proxy)) } : undefined;
  if (options.signal?.aborted) throw new TransportError('aborted');
  let stream: ReturnType<typeof got.stream> | undefined;
  try {
    stream = got.stream(url, {
      method: method as 'GET', headers, ...(options.json !== undefined ? { json: options.json } : {}),
      agent, followRedirect: false, maxRedirects: 0, retry: { limit: 0 }, throwHttpErrors: false,
      timeout: { request: timeoutMs }, signal: options.signal, decompress: true,
    });
    let status = 0;
    const receivedHeaders: Record<string, string> = {};
    stream.on('response', response => {
      status = response.statusCode;
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) receivedHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(name.toLowerCase() === 'set-cookie' ? '\n' : ', ') : String(value);
      }
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) { stream.destroy(); throw new TransportError('limit'); }
      chunks.push(data);
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    let body: unknown = null;
    if (isJsonContentType(receivedHeaders['content-type'])) { try { body = JSON.parse(text); } catch {} }
    return { status, headers: receivedHeaders, body, text };
  } catch (error) {
    if (error instanceof TransportError || error instanceof HttpError) throw error;
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    if (options.signal?.aborted || code === 'ABORT_ERR' || code === 'ERR_ABORTED') throw new TransportError('aborted');
    throw new TransportError(code === 'ETIMEDOUT' || error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  } finally {
    stream?.destroy();
    if (agent) { agent.http.destroy(); agent.https.destroy(); }
  }
}
