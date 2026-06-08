import net from 'node:net';
import { env } from '../config/env.js';

export type ProxyConfig = {
  url: string;
  enabled: boolean;
  extractUrl: string;
  expiredAt?: number;
};

export type ProxyTestResult = {
  success: boolean;
  host?: string;
  port?: number;
  latencyMs?: number;
  error?: string;
};

export type ProxyExtractResult = {
  success: boolean;
  proxyUrl?: string;
  ip?: string;
  port?: number;
  expiredAt?: number;
  error?: string;
};

export class ProxyConfigService {
  private config: ProxyConfig;

  constructor() {
    this.config = {
      url: env.CLOAK_PROXY_URL ?? '',
      enabled: !!env.CLOAK_PROXY_URL,
      extractUrl: '',
    };
  }

  get(): ProxyConfig {
    return { ...this.config };
  }

  update(patch: Partial<ProxyConfig>): void {
    if (patch.url !== undefined) {
      this.config.url = patch.url;
    }
    if (patch.enabled !== undefined) {
      this.config.enabled = patch.enabled;
    }
    if (patch.extractUrl !== undefined) {
      this.config.extractUrl = patch.extractUrl;
    }
    if (patch.expiredAt !== undefined) {
      this.config.expiredAt = patch.expiredAt;
    }
    // 同步到运行时 env（影响后续 CloakBrowser 启动）
    this.syncEnv();
  }

  async extract(): Promise<ProxyExtractResult> {
    if (!this.config.extractUrl) {
      return { success: false, error: '未配置提取链接' };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(this.config.extractUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const body = await response.json() as any;
      const proxy = parseExtractResponse(body);

      if (!proxy) {
        return { success: false, error: '无法从响应中解析代理信息' };
      }

      // 从提取链接参数或响应中判断协议
      const scheme = detectProxyScheme(this.config.extractUrl, body, proxy);

      // 构建代理 URL
      const proxyUrl = proxy.account && proxy.password
        ? `${scheme}://${encodeURIComponent(proxy.account)}:${encodeURIComponent(proxy.password)}@${proxy.ip}:${proxy.port}`
        : `${scheme}://${proxy.ip}:${proxy.port}`;

      // 自动更新配置
      this.config.url = proxyUrl;
      this.config.enabled = true;
      this.config.expiredAt = proxy.expired ?? undefined;
      this.syncEnv();

      return {
        success: true,
        proxyUrl,
        ip: proxy.ip,
        port: proxy.port,
        expiredAt: proxy.expired ?? undefined,
      };
    } catch (error) {
      const message = error instanceof Error
        ? (error.name === 'AbortError' ? '请求超时' : error.message)
        : String(error);
      return { success: false, error: message };
    }
  }

  async test(): Promise<ProxyTestResult> {
    if (!this.config.url) {
      return { success: false, error: '未配置代理地址' };
    }

    let parsed: URL;
    try {
      parsed = new URL(this.config.url);
    } catch {
      return { success: false, error: '代理地址格式无效' };
    }

    const host = parsed.hostname;
    const port = Number(parsed.port) || (parsed.protocol === 'socks5:' ? 1080 : 8080);

    const start = Date.now();
    try {
      await tcpConnect(host, port, 10_000);
      return {
        success: true,
        host,
        port,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        success: false,
        host,
        port,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private syncEnv(): void {
    if (this.config.enabled && this.config.url) {
      (env as any).CLOAK_PROXY_URL = this.config.url;
    } else {
      (env as any).CLOAK_PROXY_URL = undefined;
    }
  }
}

type ExtractedProxy = {
  ip: string;
  port: number;
  expired?: number;
  account?: string;
  password?: string;
};

/**
 * 解析代理提取 API 的响应，兼容常见格式：
 * - { data: { list: [{ ip, port, account, password, expired }] } }
 * - { data: [{ ip, port }] }
 * - { ip, port }
 */
function parseExtractResponse(body: any): ExtractedProxy | undefined {
  if (!body || typeof body !== 'object') return undefined;

  // 格式: { data: { list: [...] } }
  if (body.data?.list && Array.isArray(body.data.list) && body.data.list.length > 0) {
    return extractFromItem(body.data.list[0]);
  }

  // 格式: { data: [...] }
  if (Array.isArray(body.data) && body.data.length > 0) {
    return extractFromItem(body.data[0]);
  }

  // 格式: { list: [...] }
  if (Array.isArray(body.list) && body.list.length > 0) {
    return extractFromItem(body.list[0]);
  }

  // 格式: 顶层就是 { ip, port }
  if (body.ip && body.port) {
    return extractFromItem(body);
  }

  return undefined;
}

function extractFromItem(item: any): ExtractedProxy | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const ip = item.ip ?? item.host ?? item.server;
  const port = Number(item.port);
  if (!ip || !port) return undefined;

  return {
    ip: String(ip),
    port,
    expired: item.expired ?? item.expiredAt ?? item.expire_time ?? undefined,
    account: item.account ?? item.username ?? item.user ?? undefined,
    password: item.password ?? item.pass ?? undefined,
  };
}

/**
 * 从提取链接的参数和响应体中推断代理协议。
 * 常见供应商约定：
 *   - ipzan/快代理: protocol=1 → HTTP, protocol=3 → SOCKS5
 *   - 响应体中的 protocol/type 字段
 * 默认 HTTP（更通用）。
 */
function detectProxyScheme(extractUrl: string, body: any, _proxy: ExtractedProxy): string {
  // 1. 从响应体中检测
  const responseProtocol = body?.data?.list?.[0]?.protocol
    ?? body?.data?.[0]?.protocol
    ?? body?.protocol;

  if (responseProtocol !== undefined) {
    return protocolValueToScheme(responseProtocol);
  }

  // 2. 从提取链接 URL 参数中检测
  try {
    const url = new URL(extractUrl);
    const param = url.searchParams.get('protocol') ?? url.searchParams.get('type');
    if (param) {
      return protocolValueToScheme(param);
    }
  } catch {
    // URL 解析失败，跳过
  }

  // 3. 默认使用 HTTP
  return 'http';
}

function protocolValueToScheme(value: unknown): string {
  const str = String(value).toLowerCase().trim();
  // ipzan 约定: 1=HTTP/HTTPS, 3=SOCKS5
  if (str === '1' || str === 'http' || str === 'https') return 'http';
  if (str === '2') return 'http';
  if (str === '3' || str === 'socks5' || str === 'socks') return 'socks5';
  // 未知值默认 HTTP
  return 'http';
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`连接超时 (${timeoutMs}ms)`));
    });
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}
