import type { Locator, Page } from 'playwright-core';
import { BrowserPool } from '../../browser/browserPool.js';
import { firstLocatorWithItems, firstVisible, textFromFirst } from '../../browser/locatorUtils.js';
import { detectPageBlock, saveFailureArtifact, withTimeout } from '../../browser/pageGuards.js';
import { env } from '../../config/env.js';
import { nameConfidence, parsePrice, successResult, unavailableResult } from '../base/normalize.js';
import type { HotelPriceProvider, HotelPriceResult, PriceQuery, RateCandidate } from '../base/types.js';
import { marriottSelectors } from './marriott.selectors.js';

export class MarriottProvider implements HotelPriceProvider {
  name = 'marriott' as const;

  constructor(private readonly browserPool: BrowserPool) {}

  async query(input: PriceQuery): Promise<HotelPriceResult> {
    return withTimeout(this.runQuery(input), env.QUERY_TIMEOUT_MS, 'marriott query');
  }

  private async runQuery(input: PriceQuery): Promise<HotelPriceResult> {
    const session = await this.browserPool.page().catch((error) => ({ error }));
    if ('error' in session) {
      return unavailableResult(this.name, input, 'error', session.error instanceof Error ? session.error.message : String(session.error));
    }
    const { browser, context, page } = session;

    try {
      await page.goto(marriottSelectors.homeUrl, { waitUntil: 'domcontentloaded' });
      await this.fillSearch(page, input);

      const blocked = await detectPageBlock(page);
      if (blocked) {
        const artifact = await saveFailureArtifact(this.name, page, blocked);
        return unavailableResult(this.name, input, blocked, `${blocked} detected`, page.url(), artifact);
      }

      const match = await this.findBestHotel(page, input.hotelName);
      if (!match) {
        const artifact = await saveFailureArtifact(this.name, page, 'hotel-not-found');
        return unavailableResult(this.name, input, 'hotel_not_found', 'No matching Marriott property found', page.url(), artifact);
      }

      const candidate = await this.extractRate(match.card);
      if (!candidate.price) {
        const artifact = await saveFailureArtifact(this.name, page, 'no-availability');
        return unavailableResult(this.name, input, 'no_availability', 'No public rate found on matched Marriott property', page.url(), artifact);
      }

      return successResult(this.name, input, candidate, page.url(), match.name, match.confidence);
    } catch (error) {
      const artifact = await saveFailureArtifact(this.name, page, 'error');
      return unavailableResult(this.name, input, 'error', error instanceof Error ? error.message : String(error), page.url(), artifact);
    } finally {
      await context.close().catch(() => undefined);
      await this.browserPool.release(browser);
    }
  }

  private async fillSearch(page: Page, input: PriceQuery): Promise<void> {
    const destinationInput = await firstVisible(page, marriottSelectors.destinationInput);
    await destinationInput.fill(input.hotelName);
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.waitForTimeout(1_000);

    await this.tryFillDate(page, 'checkIn', input.checkIn);
    await this.tryFillDate(page, 'checkOut', input.checkOut);

    const searchButton = await firstVisible(page, marriottSelectors.searchButton);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => undefined),
      searchButton.click(),
    ]);
  }

  private async tryFillDate(page: Page, field: 'checkIn' | 'checkOut', value: string): Promise<void> {
    const selector = field === 'checkIn'
      ? 'input[name*="fromDate"], input[aria-label*="Check-in"], input[placeholder*="Check-in"]'
      : 'input[name*="toDate"], input[aria-label*="Check-out"], input[placeholder*="Check-out"]';
    const input = page.locator(selector).first();

    if (await input.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await input.fill(value).catch(() => undefined);
    }
  }

  private async findBestHotel(page: Page, hotelName: string): Promise<{ card: Locator; name: string; confidence: number } | undefined> {
    const cards = await firstLocatorWithItems(page, marriottSelectors.hotelCards);
    const count = Math.min(await cards.count(), 20);
    let best: { card: Locator; name: string; confidence: number } | undefined;

    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const name = await textFromFirst(card, marriottSelectors.hotelName);
      const confidence = nameConfidence(hotelName, name);

      if (!best || confidence > best.confidence) {
        best = { card, name, confidence };
      }
    }

    return best && best.confidence >= 0.45 ? best : undefined;
  }

  private async extractRate(card: Locator): Promise<RateCandidate> {
    const priceText = await textFromFirst(card, marriottSelectors.priceText);
    const parsed = parsePrice(priceText);

    return {
      price: parsed.price,
      currency: parsed.currency ?? 'USD',
      taxIncluded: /taxes included|含税/i.test(priceText),
      isMemberRate: /member|会员/i.test(priceText),
      isPrepaid: /prepay|prepaid|预付/i.test(priceText),
    };
  }
}
