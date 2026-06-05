import type { Locator, Page } from 'playwright-core';
import { BrowserPool } from '../../browser/browserPool.js';
import { firstLocatorWithItems, firstVisible, textFromFirst } from '../../browser/locatorUtils.js';
import { detectPageBlock, saveFailureArtifact, withTimeout } from '../../browser/pageGuards.js';
import { env } from '../../config/env.js';
import { nameConfidence, parsePrice, successResult, unavailableResult } from '../base/normalize.js';
import type { HotelPriceProvider, HotelPriceResult, PriceQuery, RateCandidate } from '../base/types.js';
import { ctripSelectors } from './ctrip.selectors.js';

export class CtripProvider implements HotelPriceProvider {
  name = 'ctrip' as const;

  constructor(private readonly browserPool: BrowserPool) {}

  async query(input: PriceQuery): Promise<HotelPriceResult> {
    return withTimeout(this.runQuery(input), env.QUERY_TIMEOUT_MS, 'ctrip query');
  }

  private async runQuery(input: PriceQuery): Promise<HotelPriceResult> {
    const { context, page } = await this.browserPool.page();

    try {
      await page.goto(ctripSelectors.homeUrl, { waitUntil: 'domcontentloaded' });
      await this.fillSearch(page, input);

      const blocked = await detectPageBlock(page);
      if (blocked) {
        const artifact = await saveFailureArtifact(this.name, page, blocked);
        return unavailableResult(this.name, input, blocked, `${blocked} detected`, page.url(), artifact);
      }

      const match = await this.findBestHotel(page, input.hotelName);
      if (!match) {
        const artifact = await saveFailureArtifact(this.name, page, 'hotel-not-found');
        return unavailableResult(this.name, input, 'hotel_not_found', 'No matching hotel card found', page.url(), artifact);
      }

      const candidate = await this.extractRate(match.card);
      if (!candidate.price) {
        const artifact = await saveFailureArtifact(this.name, page, 'no-availability');
        return unavailableResult(this.name, input, 'no_availability', 'No price found on matched hotel card', page.url(), artifact);
      }

      return successResult(this.name, input, candidate, page.url(), match.name, match.confidence);
    } catch (error) {
      const artifact = await saveFailureArtifact(this.name, page, 'error');
      return unavailableResult(this.name, input, 'error', error instanceof Error ? error.message : String(error), page.url(), artifact);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async fillSearch(page: Page, input: PriceQuery): Promise<void> {
    const searchInput = await firstVisible(page, ctripSelectors.hotelSearchInput);
    await searchInput.fill(input.hotelName);
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.waitForTimeout(1_000);

    await this.tryFillDate(page, input.checkIn);
    await this.tryFillDate(page, input.checkOut);

    const searchButton = await firstVisible(page, ctripSelectors.searchButton);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined),
      searchButton.click(),
    ]);
  }

  private async tryFillDate(page: Page, value: string): Promise<void> {
    const dateInput = page.locator(`input[value*="${value}"], input[placeholder*="日期"]`).first();
    if (await dateInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await dateInput.fill(value).catch(() => undefined);
    }
  }

  private async findBestHotel(page: Page, hotelName: string): Promise<{ card: Locator; name: string; confidence: number } | undefined> {
    await page.waitForLoadState('domcontentloaded');
    const cards = await firstLocatorWithItems(page, ctripSelectors.hotelCards);
    const count = Math.min(await cards.count(), 20);
    let best: { card: Locator; name: string; confidence: number } | undefined;

    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const name = await textFromFirst(card, ctripSelectors.hotelName);
      const confidence = nameConfidence(hotelName, name);

      if (!best || confidence > best.confidence) {
        best = { card, name, confidence };
      }
    }

    return best && best.confidence >= 0.45 ? best : undefined;
  }

  private async extractRate(card: Locator): Promise<RateCandidate> {
    const priceText = await textFromFirst(card, ctripSelectors.priceText);
    const parsed = parsePrice(priceText);
    return {
      price: parsed.price,
      currency: parsed.currency ?? 'CNY',
      taxIncluded: false,
    };
  }
}
