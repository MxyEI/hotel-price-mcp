import { launch } from 'cloakbrowser';
import type { Browser } from 'playwright-core';
import { env } from '../config/env.js';

type CloakLaunchOptions = {
  headless: boolean;
  humanize: boolean;
  geoip: boolean;
  proxy?: string;
  args?: string[];
};

export type CloakBrowserLaunchMeta = {
  fingerprintSeed?: number;
  proxyUrl?: string;
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
    options.proxy = env.CLOAK_PROXY_URL;
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
    },
  };
}

function randomFingerprintSeed(): number {
  const min = env.CLOAK_FINGERPRINT_MIN;
  const max = env.CLOAK_FINGERPRINT_MAX;

  if (max <= min) {
    return min;
  }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}
