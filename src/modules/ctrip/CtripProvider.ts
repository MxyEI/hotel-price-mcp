import type { Locator, Page, Response } from 'playwright-core';
import { BrowserPool } from '../../browser/browserPool.js';
import { firstLocatorWithItems, textFromFirst } from '../../browser/locatorUtils.js';
import { detectPageBlock, saveFailureArtifact, withTimeout } from '../../browser/pageGuards.js';
import { env } from '../../config/env.js';
import { nameConfidence, parsePrice, successResult, unavailableResult } from '../base/normalize.js';
import type { HotelPriceProvider, HotelPriceResult, PriceQuery, RateCandidate } from '../base/types.js';
import { ctripSelectors } from './ctrip.selectors.js';

type CtripHotelCandidate = {
  hotelName: string;
  confidence: number;
  price?: number;
  currency?: string;
  sourceUrl?: string;
};

export class CtripProvider implements HotelPriceProvider {
  name = 'ctrip' as const;

  constructor(private readonly browserPool: BrowserPool) {}

  async query(input: PriceQuery): Promise<HotelPriceResult> {
    return withTimeout(this.runQuery(input), env.QUERY_TIMEOUT_MS, 'ctrip query');
  }

  private async runQuery(input: PriceQuery): Promise<HotelPriceResult> {
    const session = await this.browserPool.page().catch((error) => ({ error }));
    if ('error' in session) {
      return unavailableResult(this.name, input, 'error', session.error instanceof Error ? session.error.message : String(session.error));
    }
    const { browser, context, page } = session;

    try {
      const searchUrl = ctripSelectors.searchUrl(input.hotelName, input.checkIn, input.checkOut, input.adults);

      // 拦截 API 响应获取结构化数据
      const apiCandidates = await this.navigateAndCapture(page, searchUrl, input);

      const blocked = await detectPageBlock(page);
      if (blocked) {
        const artifact = await saveFailureArtifact(this.name, page, blocked);
        return unavailableResult(this.name, input, blocked, `${blocked} detected`, page.url(), artifact);
      }

      // 优先用 API 数据
      const apiMatch = this.pickBest(apiCandidates, input.hotelName);
      if (apiMatch?.price) {
        return successResult(this.name, input, {
          price: apiMatch.price,
          currency: apiMatch.currency ?? 'CNY',
          taxIncluded: false,
        }, apiMatch.sourceUrl ?? page.url(), apiMatch.hotelName, apiMatch.confidence);
      }

      // API 没拿到就 fallback 到 DOM 解析
      const domMatch = await this.findBestHotelFromDom(page, input.hotelName);
      if (!domMatch) {
        const artifact = await saveFailureArtifact(this.name, page, 'hotel-not-found');
        return unavailableResult(this.name, input, 'hotel_not_found', 'No matching hotel found', page.url(), artifact);
      }

      const candidate = await this.extractRate(domMatch.card);
      if (!candidate.price) {
        const artifact = await saveFailureArtifact(this.name, page, 'no-availability');
        return unavailableResult(this.name, input, 'no_availability', 'No price found on matched hotel card', page.url(), artifact);
      }

      return successResult(this.name, input, candidate, page.url(), domMatch.name, domMatch.confidence);
    } catch (error) {
      const artifact = await saveFailureArtifact(this.name, page, 'error');
      return unavailableResult(this.name, input, 'error', error instanceof Error ? error.message : String(error), page.url(), artifact);
    } finally {
      if (!input.keepBrowserOpen) {
        await context.close().catch(() => undefined);
        await this.browserPool.release(browser);
      }
    }
  }

  private async navigateAndCapture(page: Page, url: string, input: PriceQuery): Promise<CtripHotelCandidate[]> {
    const candidates: CtripHotelCandidate[] = [];

    const onResponse = async (response: Response) => {
      const resUrl = response.url();
      if (!ctripSelectors.apiResponsePattern.test(resUrl)) return;

      const contentType = response.headers()['content-type'] ?? '';
      if (!/json/i.test(contentType)) return;

      try {
        const body = await response.json().catch(() => null);
        if (!body) return;
        const extracted = this.extractFromApiResponse(body, input);
        candidates.push(...extracted);
      } catch {
        // 忽略不可读的响应
      }
    };

    page.on('response', onResponse);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
      // 额外等待确保懒加载的 API 调用完成
      await page.waitForTimeout(3_000);
    } finally {
      page.off('response', onResponse);
    }

    return candidates;
  }

  private extractFromApiResponse(body: unknown, input: PriceQuery): CtripHotelCandidate[] {
    const candidates: CtripHotelCandidate[] = [];
    const hotels = findHotelList(body);

    for (const hotel of hotels) {
      const basicInfo = hotel.hotelBasicInfo as JsonRecord | undefined;
      const name = (hotel.hotelName ?? hotel.hotel_name ?? hotel.name ?? basicInfo?.hotelName) as string | undefined;
      if (!name) continue;

      const price = extractCtripPrice(hotel);
      const confidence = nameConfidence(input.hotelName, name);
      const hotelId = hotel.hotelId ?? hotel.hotel_id ?? hotel.id;
      const sourceUrl = hotelId
        ? `https://hotels.ctrip.com/hotels/${hotelId}.html`
        : undefined;

      candidates.push({ hotelName: name, confidence, price, currency: 'CNY', sourceUrl });
    }

    return candidates;
  }

  private pickBest(candidates: CtripHotelCandidate[], hotelName: string): CtripHotelCandidate | undefined {
    const withPrice = candidates.filter((c) => c.price);
    const source = withPrice.length > 0 ? withPrice : candidates;

    let best: CtripHotelCandidate | undefined;
    for (const c of source) {
      if (!best || c.confidence > best.confidence) {
        best = c;
      }
    }

    return best && best.confidence >= 0.4 ? best : undefined;
  }

  private async findBestHotelFromDom(page: Page, hotelName: string): Promise<{ card: Locator; name: string; confidence: number } | undefined> {
    let cards: Locator;
    try {
      cards = await firstLocatorWithItems(page, ctripSelectors.hotelCards, 5_000);
    } catch {
      return undefined;
    }

    const count = Math.min(await cards.count(), 20);
    let best: { card: Locator; name: string; confidence: number } | undefined;

    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const name = await textFromFirst(card, ctripSelectors.hotelName);
      if (!name) continue;
      const confidence = nameConfidence(hotelName, name);

      if (!best || confidence > best.confidence) {
        best = { card, name, confidence };
      }
    }

    return best && best.confidence >= 0.4 ? best : undefined;
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

// --- 辅助函数：从携程 API 响应中提取酒店列表 ---

type JsonRecord = Record<string, unknown>;

function findHotelList(body: unknown): JsonRecord[] {
  if (!body || typeof body !== 'object') return [];

  const obj = body as JsonRecord;

  // 常见携程 API 响应格式
  // { hotelList: [...] }
  if (Array.isArray(obj.hotelList)) return obj.hotelList as JsonRecord[];

  // { data: { hotelList: [...] } }
  const data = obj.data as JsonRecord | undefined;
  if (data && Array.isArray(data.hotelList)) return data.hotelList as JsonRecord[];

  // { result: [...] }
  if (Array.isArray(obj.result)) return obj.result as JsonRecord[];

  // { Response: { body: { hotelList: [...] } } }
  const response = obj.Response as JsonRecord | undefined;
  if (response) {
    const rBody = response.body as JsonRecord | undefined;
    if (rBody && Array.isArray(rBody.hotelList)) return rBody.hotelList as JsonRecord[];
  }

  // 递归查找含有 hotelList 的嵌套结构
  return deepFindArray(body, 'hotelList', 3);
}

function deepFindArray(value: unknown, key: string, depth: number): JsonRecord[] {
  if (depth <= 0 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return [];

  const obj = value as JsonRecord;
  if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 0) {
    return obj[key] as JsonRecord[];
  }

  for (const child of Object.values(obj)) {
    const found = deepFindArray(child, key, depth - 1);
    if (found.length > 0) return found;
  }
  return [];
}

function extractCtripPrice(hotel: JsonRecord): number | undefined {
  // hotel.money / hotel.price / hotel.lowestPrice
  const direct = hotel.money ?? hotel.price ?? hotel.lowestPrice ?? hotel.lowest_price;
  if (typeof direct === 'number' && direct > 0) return direct;
  if (typeof direct === 'string') {
    const num = Number(direct.replace(/,/g, ''));
    if (num > 0) return num;
  }

  // hotel.priceInfo.price
  const priceInfo = hotel.priceInfo as JsonRecord | undefined;
  if (priceInfo) {
    const p = priceInfo.price ?? priceInfo.lowestPrice ?? priceInfo.amount;
    if (typeof p === 'number' && p > 0) return p;
    if (typeof p === 'string') {
      const num = Number(p.replace(/,/g, ''));
      if (num > 0) return num;
    }
  }

  // hotel.hotelBasicInfo.price
  const basicInfo = hotel.hotelBasicInfo as JsonRecord | undefined;
  if (basicInfo) {
    const p = basicInfo.price ?? basicInfo.lowestPrice;
    if (typeof p === 'number' && p > 0) return p;
  }

  return undefined;
}
