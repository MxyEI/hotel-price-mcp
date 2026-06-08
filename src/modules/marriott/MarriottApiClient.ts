import type { Page, Response } from 'playwright-core';
import { nameConfidence } from '../base/normalize.js';
import type { PriceQuery, RateCandidate } from '../base/types.js';

const MARRIOTT_ORIGIN = 'https://www.marriott.com.cn';
const MARRIOTT_HOME = `${MARRIOTT_ORIGIN}/default.mi`;
const API_RESPONSE_PATTERN = /\/mi\/query|graphql|availability|search|findHotels/i;
const SEARCH_RESULT_TYPENAME = 'SearchLowestAvailableRates';
const SEARCH_EDGE_TYPENAME = 'SearchLowestAvailableRatesSearchEdge';

type JsonRecord = Record<string, unknown>;

type MarriottRate = {
  status?: { code?: string };
  rateCategory?: { code?: string; value?: string };
  rate_category?: { code?: string; value?: string };
  rateModes?: JsonRecord | null;
  rate_modes?: JsonRecord | null;
  membersOnly?: boolean | null;
  members_only?: boolean | null;
  sourceOfRate?: string;
  source_of_rate?: string;
};

type MarriottProperty = {
  id?: string;
  seoNickname?: string;
  seo_nickname?: string;
  basicInformation?: MarriottBasicInformation;
  basic_information?: MarriottBasicInformation;
};

type MarriottBasicInformation = {
  name?: string;
  nameInDefaultLanguage?: string;
  name_in_default_language?: string;
  currency?: string;
};

type MarriottSearchNode = {
  __typename?: string;
  distance?: number | null;
  property?: MarriottProperty;
  rates?: MarriottRate[];
};

type MarriottApiCandidate = {
  hotelCode?: string;
  hotelName: string;
  seoNickname?: string;
  confidence: number;
  sourceUrl: string;
  candidate: RateCandidate;
};

export type MarriottApiMatch = MarriottApiCandidate;

export class MarriottApiClient {
  private readonly apiPayloads: unknown[] = [];

  constructor(private readonly page: Page) {}

  async findPrice(input: PriceQuery): Promise<MarriottApiMatch | undefined> {
    // 先访问首页预热 session，建立 cookie 避免被反爬拦截
    await this.warmup();

    const searchUrl = this.buildSearchUrl(input);
    await this.captureApiResponses(async () => {
      // 带 referrer 导航，模拟从首页跳转
      await this.page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        referer: MARRIOTT_HOME,
      });
      await this.page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => undefined);
      await this.page.waitForTimeout(3_000 + Math.random() * 2_000);
    });

    const candidates = [
      ...this.extractCandidatesFromPayloads(input, this.apiPayloads),
      ...await this.extractCandidatesFromPageState(input).catch(() => []),
    ];

    return this.pickBestCandidate(input, candidates);
  }

  private async warmup(): Promise<void> {
    try {
      await this.page.goto(MARRIOTT_HOME, { waitUntil: 'domcontentloaded' });
      // 随机等待 2-4 秒，模拟人类浏览
      await this.page.waitForTimeout(2_000 + Math.random() * 2_000);
      // 轻微滚动，触发更多 cookie / JS 初始化
      await this.page.evaluate(() => window.scrollBy(0, 200));
      await this.page.waitForTimeout(500 + Math.random() * 500);
    } catch {
      // 预热失败不阻塞主流程
    }
  }

  buildSearchUrl(input: PriceQuery): string {
    const params = new URLSearchParams({
      fromDate: toMarriottDate(input.checkIn),
      toDate: toMarriottDate(input.checkOut),
      fromDateDefaultFormat: toMarriottDate(input.checkIn),
      toDateDefaultFormat: toMarriottDate(input.checkOut),
      lengthOfStay: String(nightsBetween(input.checkIn, input.checkOut)),
      flexibleDateSearch: 'false',
      useRewardsPoints: 'false',
      isAdvanceSearch: 'false',
      recordsPerPage: '20',
      searchType: 'InCity',
      singleSearch: 'true',
      isTransient: 'true',
      isSearch: 'true',
      destinationAddress_destination: input.hotelName,
      'destinationAddress.destination': input.hotelName,
      roomCount: String(input.rooms),
      numAdultsPerRoom: String(input.adults),
      childrenCount: String(input.children),
      deviceType: 'desktop-web',
      view: 'list',
      currentOffset: '0',
    });

    return `${MARRIOTT_ORIGIN}/search/findHotels.mi?${params}`;
  }

  private async captureApiResponses(action: () => Promise<void>): Promise<void> {
    const onResponse = async (response: Response) => {
      const url = response.url();
      if (!API_RESPONSE_PATTERN.test(url)) {
        return;
      }

      const contentType = response.headers()['content-type'] ?? '';
      if (!/json|javascript|text/i.test(contentType)) {
        return;
      }

      try {
        const text = await response.text();
        if (!text.includes(SEARCH_RESULT_TYPENAME) && !looksLikeJson(text)) {
          return;
        }

        const parsed = parsePossibleJson(text);
        if (parsed) {
          this.apiPayloads.push(parsed);
        }
      } catch {
        // Some protected or streaming responses cannot be read. Ignore them and
        // keep collecting the rest of the page's API traffic.
      }
    };

    this.page.on('response', onResponse);
    try {
      await action();
    } finally {
      this.page.off('response', onResponse);
    }
  }

  private extractCandidatesFromPayloads(input: PriceQuery, payloads: unknown[]): MarriottApiCandidate[] {
    const seen = new Set<string>();
    const candidates: MarriottApiCandidate[] = [];

    for (const payload of payloads) {
      for (const node of findSearchNodes(payload)) {
        const candidate = this.toCandidate(input, node);
        const key = `${candidate?.hotelCode ?? ''}:${candidate?.hotelName}`;
        if (candidate && !seen.has(key)) {
          seen.add(key);
          candidates.push(candidate);
        }
      }
    }

    return candidates;
  }

  private async extractCandidatesFromPageState(input: PriceQuery): Promise<MarriottApiCandidate[]> {
    const payloads = await this.page.evaluate(() => {
      const values: unknown[] = [];
      const keys = [
        '__APOLLO_STATE__',
        '__INITIAL_STATE__',
        '__NEXT_DATA__',
        '__PRELOADED_STATE__',
      ];

      for (const key of keys) {
        const value = (window as unknown as Record<string, unknown>)[key];
        if (value) {
          values.push(value);
        }
      }

      for (const script of document.querySelectorAll('script[type="application/json"], script:not([src])')) {
        const text = script.textContent ?? '';
        if (text.includes('SearchLowestAvailableRates')) {
          values.push(text);
        }
      }

      return values;
    });

    return this.extractCandidatesFromPayloads(input, payloads.map(parsePossibleJson));
  }

  private pickBestCandidate(input: PriceQuery, candidates: MarriottApiCandidate[]): MarriottApiMatch | undefined {
    const priced = candidates.filter((item) => item.candidate.price);
    const source = priced.length > 0 ? priced : candidates;
    let best: MarriottApiCandidate | undefined;

    for (const candidate of source) {
      if (!best || candidate.confidence > best.confidence) {
        best = candidate;
      }
    }

    if (!best) {
      return undefined;
    }

    return best.confidence >= 0.35 || source.length === 1 ? best : undefined;
  }

  private toCandidate(input: PriceQuery, node: MarriottSearchNode): MarriottApiCandidate | undefined {
    const property = node.property;
    const basic = property?.basicInformation ?? property?.basic_information;
    const hotelName = basic?.name ?? basic?.nameInDefaultLanguage ?? basic?.name_in_default_language;
    if (!hotelName) {
      return undefined;
    }

    const candidate = this.toRateCandidate(node.rates ?? [], basic?.currency);
    return {
      hotelCode: property?.id,
      hotelName,
      seoNickname: property?.seoNickname ?? property?.seo_nickname,
      confidence: nameConfidence(input.hotelName, hotelName),
      sourceUrl: this.buildHotelUrl(property),
      candidate,
    };
  }

  private toRateCandidate(rates: MarriottRate[], fallbackCurrency?: string): RateCandidate {
    const preferredRate = rates.find((rate) => rate.status?.code === 'AvailableForSale' && extractRateAmount(rate))
      ?? rates.find((rate) => extractRateAmount(rate))
      ?? rates[0];
    const money = preferredRate ? extractRateAmount(preferredRate) : undefined;
    const category = preferredRate?.rateCategory ?? preferredRate?.rate_category;

    return {
      price: money?.amount,
      currency: money?.currency ?? fallbackCurrency,
      taxIncluded: money?.taxIncluded,
      rateName: category?.code ?? category?.value ?? preferredRate?.sourceOfRate ?? preferredRate?.source_of_rate,
      isMemberRate: Boolean(preferredRate?.membersOnly ?? preferredRate?.members_only),
    };
  }

  private buildHotelUrl(property: MarriottProperty | undefined): string {
    const seoNickname = property?.seoNickname ?? property?.seo_nickname;
    if (seoNickname) {
      return `${MARRIOTT_ORIGIN}/hotels/${seoNickname}/overview/`;
    }

    return property?.id
      ? `${MARRIOTT_ORIGIN}/search/findHotels.mi?propertyCode=${encodeURIComponent(property.id)}`
      : MARRIOTT_ORIGIN;
  }
}

function findSearchNodes(value: unknown): MarriottSearchNode[] {
  const nodes: MarriottSearchNode[] = [];
  const visited = new Set<object>();

  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    if (visited.has(item)) {
      return;
    }
    visited.add(item);

    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }

    const record = item as JsonRecord;
    if (record.__typename === SEARCH_EDGE_TYPENAME && isRecord(record.node)) {
      visit(record.node);
      return;
    }

    if (record.__typename === SEARCH_RESULT_TYPENAME && isRecord(record.property)) {
      nodes.push(record as MarriottSearchNode);
      return;
    }

    if (isRecord(record.property) && Array.isArray(record.rates)) {
      nodes.push(record as MarriottSearchNode);
      return;
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(value);
  return nodes;
}

function extractRateAmount(rate: MarriottRate): { amount: number; currency?: string; taxIncluded: boolean } | undefined {
  const modes = rate.rateModes ?? rate.rate_modes;
  const average = getPath(modes, ['lowestAverageRate'])
    ?? getPath(modes, ['lowest_average_rate'])
    ?? modes;

  const amountPlusFees = readMoney(getPath(average, ['amountPlusMandatoryFees']) ?? getPath(average, ['amount_plus_mandatory_fees']));
  const amount = readMoney(getPath(average, ['amount']));
  const total = readMoney(getPath(average, ['totalAmount']) ?? getPath(average, ['total_amount']));
  const selected = amountPlusFees ?? amount ?? total;

  if (!selected) {
    return undefined;
  }

  return {
    ...selected,
    taxIncluded: selected === total,
  };
}

function readMoney(value: unknown): { amount: number; currency?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawAmount = value.amount;
  const amount = typeof rawAmount === 'number'
    ? rawAmount
    : typeof rawAmount === 'string'
      ? Number(rawAmount.replace(/,/g, ''))
      : undefined;

  if (amount === undefined || !Number.isFinite(amount)) {
    return undefined;
  }

  const decimalPoint = Number(value.decimalPoint ?? value.decimal_point ?? 0);
  const divisor = decimalPoint > 0 ? 10 ** decimalPoint : 1;
  const currency = typeof value.currency === 'string' ? value.currency : undefined;

  return {
    amount: amount / divisor,
    currency,
  };
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function toMarriottDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${month}/${day}/${year}`;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  const nights = Math.round((end - start) / 86_400_000);
  return nights > 0 ? nights : 1;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function parsePossibleJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!looksLikeJson(trimmed)) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
