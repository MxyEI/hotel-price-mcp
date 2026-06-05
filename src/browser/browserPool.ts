import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { CloakBrowserLaunchMeta } from './cloakClient.js';
import { closeCloakProxy, launchCloakBrowser } from './cloakClient.js';

export class BrowserPool {
  private readonly activeBrowsers = new Set<Browser>();
  private readonly launchMeta = new Map<Browser, CloakBrowserLaunchMeta>();

  async page(): Promise<{ browser: Browser; context: BrowserContext; page: Page; meta: CloakBrowserLaunchMeta }> {
    const { browser, meta } = await launchCloakBrowser();
    this.activeBrowsers.add(browser);
    this.launchMeta.set(browser, meta);
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage();
    return { browser, context, page, meta };
  }

  async release(browser: Browser): Promise<void> {
    const meta = this.launchMeta.get(browser);
    this.activeBrowsers.delete(browser);
    this.launchMeta.delete(browser);
    await browser.close().catch(() => undefined);
    if (meta) {
      await closeCloakProxy(meta);
    }
  }

  async close(): Promise<void> {
    const browsers = [...this.activeBrowsers];
    this.activeBrowsers.clear();
    await Promise.all(browsers.map(async (browser) => {
      const meta = this.launchMeta.get(browser);
      this.launchMeta.delete(browser);
      await browser.close().catch(() => undefined);
      if (meta) {
        await closeCloakProxy(meta);
      }
    }));
  }
}
