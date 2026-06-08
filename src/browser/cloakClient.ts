import { launch } from 'cloakbrowser';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import type { Browser } from 'playwright-core';
import { env } from '../config/env.js';

type CloakLaunchOptions = {
  headless: boolean;
  humanize: boolean;
  geoip: boolean;
  proxy?: string;
  args?: string[];
  launchOptions?: {
    proxy?: {
      server: string;
      username?: string;
      password?: string;
    };
  };
};

export type CloakBrowserLaunchMeta = {
  fingerprintSeed?: number;
  proxyUrl?: string;
  anonymizedProxyUrl?: string;
};

export type CloakBrowserLaunch = {
  browser: Browser;
  meta: CloakBrowserLaunchMeta;
};

export async function launchCloakBrowser(): Promise<CloakBrowserLaunch> {
  if (env.CLOAK_REQUIRE_PROXY && !env.CLOAK_PROXY_URL) {
    throw new Error('CLOAK_PROXY_URL is required when CLOAK_REQUIRE_PROXY=true');
  }

  const fingerprintSeed = env.CLOAK_FINGERPRINT_ROTATE ? randomFingerprintSeed() : undefined;
  const options: CloakLaunchOptions = {
    headless: env.CLOAK_HEADLESS,
    humanize: env.CLOAK_HUMANIZE,
    geoip: env.CLOAK_GEOIP,
  };

  if (env.CLOAK_PROXY_URL) {
    await applyProxyOption(options, env.CLOAK_PROXY_URL);
  }

  if (fingerprintSeed) {
    options.args = [`--fingerprint=${fingerprintSeed}`];
  }

  const browser = await launch(options) as Browser;
  return {
    browser,
    meta: {
      fingerprintSeed,
      proxyUrl: env.CLOAK_PROXY_URL,
      anonymizedProxyUrl: options.proxy !== env.CLOAK_PROXY_URL ? options.proxy : undefined,
    },
  };
}

export async function closeCloakProxy(meta: CloakBrowserLaunchMeta): Promise<void> {
  if (meta.anonymizedProxyUrl) {
    await closeAnonymizedProxy(meta.anonymizedProxyUrl, true).catch(() => undefined);
  }
}

export async function prepareCloakProxy(proxyUrl: string): Promise<{ proxyUrl: string; anonymizedProxyUrl?: string; geoip: boolean }> {
  const parsed = parseProxyUrl(proxyUrl);

  // 带认证的代理统一走 anonymizeProxy 本地桥接：
  // - SOCKS5: Chromium/Playwright 不直接支持 SOCKS5 auth
  // - HTTP: darwin 平台 CloakBrowser 不支持 inline auth，CDP 拦截器对国内代理兼容差
  // anonymizeProxy 在本地起一个无需认证的 HTTP 代理，透明转发到上游带认证代理
  if (parsed?.username) {
    const anonymizedProxyUrl = await anonymizeProxy(proxyUrl);
    return {
      proxyUrl: anonymizedProxyUrl,
      anonymizedProxyUrl,
      geoip: false,
    };
  }

  return {
    proxyUrl,
    geoip: env.CLOAK_GEOIP,
  };
}

async function applyProxyOption(options: CloakLaunchOptions, proxyUrl: string): Promise<void> {
  const prepared = await prepareCloakProxy(proxyUrl);
  options.proxy = prepared.proxyUrl;
  options.geoip = prepared.geoip;
}

function parseProxyUrl(proxyUrl: string): { server: string; username?: string; password?: string } | undefined {
  try {
    const url = new URL(proxyUrl);
    const server = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;

    return {
      server,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
    };
  } catch {
    return undefined;
  }
}

function randomFingerprintSeed(): number {
  const min = env.CLOAK_FINGERPRINT_MIN;
  const max = env.CLOAK_FINGERPRINT_MAX;

  if (max <= min) {
    return min;
  }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}
