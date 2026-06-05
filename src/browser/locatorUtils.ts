import type { Locator, Page } from 'playwright-core';

export async function firstVisible(page: Page, selectors: string[], timeout = 3_000): Promise<Locator> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      return locator;
    }
  }

  throw new Error(`No visible selector found: ${selectors.join(', ')}`);
}

export async function firstLocatorWithItems(page: Page, selectors: string[], timeout = 8_000): Promise<Locator> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (await locator.first().isVisible({ timeout }).catch(() => false)) {
      return locator;
    }
  }

  throw new Error(`No list selector found: ${selectors.join(', ')}`);
}

export async function textFromFirst(scope: Locator, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    const text = await locator.innerText({ timeout: 1_000 }).catch(() => '');
    if (text.trim()) {
      return text.trim();
    }
  }

  return '';
}
