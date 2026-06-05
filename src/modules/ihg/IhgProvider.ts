import { BrowserPool } from '../../browser/browserPool.js';
import { detectPageBlock, saveFailureArtifact, withTimeout } from '../../browser/pageGuards.js';
import { env } from '../../config/env.js';
import { successResult, unavailableResult } from '../base/normalize.js';
import type { HotelPriceProvider, HotelPriceResult, PriceQuery } from '../base/types.js';
import { IhgApiClient } from './IhgApiClient.js';

export class IhgProvider implements HotelPriceProvider {
  name = 'ihg' as const;

  constructor(private readonly browserPool: BrowserPool) {}

  async query(input: PriceQuery): Promise<HotelPriceResult> {
    return withTimeout(this.runQuery(input), env.QUERY_TIMEOUT_MS, 'ihg query');
  }

  private async runQuery(input: PriceQuery): Promise<HotelPriceResult> {
    const session = await this.browserPool.page().catch((error) => ({ error }));
    if ('error' in session) {
      return unavailableResult(this.name, input, 'error', session.error instanceof Error ? session.error.message : String(session.error));
    }
    const { browser, context, page, meta } = session;

    try {
      if (meta.fingerprintSeed) {
        console.log(`[ihg] fingerprint=${meta.fingerprintSeed}`);
      }
      const apiClient = new IhgApiClient(page);
      const match = await apiClient.findPrice(input);

      const blocked = await detectPageBlock(page);
      if (blocked) {
        const artifact = await saveFailureArtifact(this.name, page, blocked);
        return unavailableResult(this.name, input, blocked, `${blocked} detected`, page.url(), artifact);
      }

      if (!match) {
        const artifact = await saveFailureArtifact(this.name, page, 'hotel-not-found');
        return unavailableResult(this.name, input, 'hotel_not_found', 'No matching IHG API hotel found', page.url(), artifact);
      }

      return successResult(this.name, input, match.candidate, match.sourceUrl, match.hotelName, match.confidence);
    } catch (error) {
      const artifact = await saveFailureArtifact(this.name, page, 'error');
      return unavailableResult(this.name, input, 'error', error instanceof Error ? error.message : String(error), page.url(), artifact);
    } finally {
      await context.close().catch(() => undefined);
      await this.browserPool.release(browser);
    }
  }
}
