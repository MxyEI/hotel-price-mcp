import type { Browser, BrowserContext, Page } from 'playwright-core';
import { launchCloakBrowser } from './cloakClient.js';

export class BrowserPool {
  private browser?: Browser;

  async page(): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage();
    return { context, page };
  }

  async close(): Promise<void> {
    if (!this.browser) {
      return;
    }

    await this.browser.close();
    this.browser = undefined;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await launchCloakBrowser();
    }

    return this.browser;
  }
}
