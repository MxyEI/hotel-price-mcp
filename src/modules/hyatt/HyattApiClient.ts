import type { Page } from 'playwright-core';
import { nameConfidence } from '../base/normalize.js';
import type { PriceQuery, RateCandidate } from '../base/types.js';

const HYATT_ORIGIN = 'https://www.hyatt.com';
const HYATT_SEARCH_BASE = `${HYATT_ORIGIN}/search/hotels/zh-CN`;

/** DOM 提取的酒店卡片数据 */
type HyattHotelCard = {
  spiritCode: string;
  name: string;
  brand: string;
  bookingStatus: string;
  distance: string;
  latitude: string;
  longitude: string;
  price: number | null;
  currency: string;
  awardCategory: number | null;
  rating: number | null;
  reviewCount: number | null;
};

export type HyattApiMatch = {
  hotelCode: string;
  hotelName: string;
  confidence: number;
  sourceUrl: string;
  candidate: RateCandidate;
};

export class HyattApiClient {
  constructor(private readonly page: Page) {}

  async findPrice(input: PriceQuery): Promise<HyattApiMatch | undefined> {
    await this.dismissCookieBanner();

    const searchUrl = this.buildSearchUrl(input);
    await this.page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
    });

    // 等待 SSR 内容渲染完成
    await this.waitForHotelCards();

    const hotels = await this.extractHotelCards();

    if (hotels.length === 0) {
      return undefined;
    }

    return this.pickBestMatch(input, hotels, searchUrl);
  }

  private buildSearchUrl(input: PriceQuery): string {
    const destination = encodeURIComponent(input.hotelName);
    const params = new URLSearchParams({
      checkinDate: input.checkIn,
      checkoutDate: input.checkOut,
      rooms: String(input.rooms),
      adults: String(input.adults),
    });

    if (input.children > 0) {
      params.set('kids', String(input.children));
    }

    return `${HYATT_SEARCH_BASE}/${destination}?${params}`;
  }

  private async dismissCookieBanner(): Promise<void> {
    try {
      // 先访问首页建立 session
      await this.page.goto(`${HYATT_ORIGIN}/zh-CN`, {
        waitUntil: 'domcontentloaded',
      });
      await this.page.waitForTimeout(2_000 + Math.random() * 1_000);

      // 通过 OneTrust API 或按钮关闭 Cookie 弹窗
      await this.page.evaluate(() => {
        const btn = document.querySelector('#onetrust-accept-btn-handler') as HTMLElement | null;
        if (btn && btn.offsetParent) {
          btn.click();
          return;
        }
        if (typeof (window as any).Optanon !== 'undefined' && typeof (window as any).Optanon.AcceptAll === 'function') {
          (window as any).Optanon.AcceptAll();
        }
      });
      await this.page.waitForTimeout(500);
    } catch {
      // Cookie 弹窗处理失败不阻塞主流程
    }
  }

  private async waitForHotelCards(): Promise<void> {
    // 等待酒店卡片出现，最多 20 秒
    try {
      await this.page.waitForSelector('[data-js="hotel-card"]', { timeout: 20_000 });
      // 额外等待动态渲染完成
      await this.page.waitForTimeout(2_000 + Math.random() * 1_000);
    } catch {
      // 如果卡片未出现，后续 extractHotelCards 会返回空数组
      await this.page.waitForTimeout(3_000);
    }
  }

  private async extractHotelCards(): Promise<HyattHotelCard[]> {
    return this.page.evaluate(() => {
      const cards = document.querySelectorAll('[data-js="hotel-card"]');
      const hotels: HyattHotelCard[] = [];

      for (const card of cards) {
        const spiritCode = card.getAttribute('data-spirit-code') || '';
        if (!spiritCode) continue;

        const brand = card.getAttribute('data-brand') || '';
        const bookingStatus = card.getAttribute('data-booking-status') || '';
        const distance = card.getAttribute('data-distance-from-centerpoint') || '';
        const latitude = card.getAttribute('data-latitude') || '';
        const longitude = card.getAttribute('data-longitude') || '';

        // 酒店名称 — 从卡片内 title 元素提取
        const nameEl = card.querySelector('[id*="map-result-card-title"]');
        const name = nameEl ? nameEl.textContent!.trim() : '';

        // 价格 — 从文本中匹配 ¥ 或 CNY 金额
        const cardText = card.textContent || '';
        const priceMatch = cardText.match(/¥([\d,]+)/);
        let price: number | null = null;
        if (priceMatch) {
          price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
        }

        // 判断货币（中文页面默认 CNY）
        const currency = 'CNY';

        // 奖励类别
        const categoryMatch = cardText.match(/奖励类别\s*(\d+)/);
        const awardCategory = categoryMatch ? parseInt(categoryMatch[1], 10) : null;

        // 评分
        const ratingMatch = cardText.match(/(\d+\.?\d*)\s*\((\d+)\)/);
        const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
        const reviewCount = ratingMatch ? parseInt(ratingMatch[2], 10) : null;

        hotels.push({
          spiritCode,
          name,
          brand,
          bookingStatus,
          distance,
          latitude,
          longitude,
          price,
          currency,
          awardCategory,
          rating,
          reviewCount,
        });
      }

      return hotels;
    });
  }

  private pickBestMatch(input: PriceQuery, hotels: HyattHotelCard[], searchUrl: string): HyattApiMatch | undefined {
    let best: HyattApiMatch | undefined;

    for (const hotel of hotels) {
      if (!hotel.name) continue;

      const confidence = nameConfidence(input.hotelName, hotel.name);
      const candidate = this.toRateCandidate(hotel);

      // 优先选有价格且置信度最高的
      if (!best
        || (candidate.price && !best.candidate.price)
        || (candidate.price && best.candidate.price && confidence > best.confidence)
        || (!candidate.price && !best.candidate.price && confidence > best.confidence)
      ) {
        best = {
          hotelCode: hotel.spiritCode,
          hotelName: hotel.name,
          confidence,
          sourceUrl: this.buildHotelUrl(hotel.spiritCode),
          candidate,
        };
      }
    }

    // 如果最佳匹配置信度过低，但列表只有 1 个结果也接受
    if (!best) return undefined;
    return best.confidence >= 0.35 || hotels.length === 1 ? best : undefined;
  }

  private toRateCandidate(hotel: HyattHotelCard): RateCandidate {
    return {
      price: hotel.price ?? undefined,
      currency: hotel.price ? hotel.currency : undefined,
      taxIncluded: true, // 凯悦中文站显示的是含税价
      rateName: 'StandardRate',
      isMemberRate: false,
    };
  }

  private buildHotelUrl(spiritCode: string): string {
    return `${HYATT_ORIGIN}/zh-CN/hotel/${spiritCode}`;
  }
}
