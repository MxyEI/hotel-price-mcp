import { launch } from 'cloakbrowser';
import type { Browser } from 'playwright-core';
import { env } from '../config/env.js';

type CloakLaunchOptions = {
  headless: boolean;
  humanize: boolean;
  geoip: boolean;
  proxy?: string;
};

export async function launchCloakBrowser(): Promise<Browser> {
  const options: CloakLaunchOptions = {
    headless: env.CLOAK_HEADLESS,
    humanize: env.CLOAK_HUMANIZE,
    geoip: env.CLOAK_GEOIP,
  };

  if (env.CLOAK_PROXY_URL) {
    options.proxy = env.CLOAK_PROXY_URL;
  }

  return launch(options) as Promise<Browser>;
}
