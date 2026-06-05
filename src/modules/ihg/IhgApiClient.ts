import type { Page } from 'playwright-core';
import { nameConfidence } from '../base/normalize.js';
import type { PriceQuery, RateCandidate } from '../base/types.js';

const IHG_API_HOST = 'apis.ihg.com.cn';
const IHG_WEB_ORIGIN = 'https://www.ihg.com.cn';
const IHG_API_KEY = 'pQM1YazQwnWi5AWXmoRoA5FSfW0S9x8A';

type IhgDestination = {
  latitude?: number;
  longitude?: number;
  clarifiedLocation?: string;
  searchRadius?: {
    distance?: string;
    unit?: string;
  };
};

type IhgOfferHotel = {
  hotelMnemonic?: string;
  availabilityStatus?: string;
  propertyCurrency?: string;
  lowestCashOnlyCost?: IhgMoney;
  totalStayLowestCashOnlyCost?: IhgMoney;
  ratePlanDefinitions?: Array<{
    code?: string;
    providerDescription?: string;
    rateRange?: {
      low?: IhgMoney;
      high?: IhgMoney;
    };
  }>;
};

type IhgMoney = {
  baseAmount?: string;
  amountAfterTax?: string;
  excludedFeeSubTotal?: string;
  excludedTaxSubTotal?: string;
};

type IhgOffersResponse = {
  hotels?: IhgOfferHotel[];
  warnings?: Array<{ message?: string; code?: string }>;
};

type IhgProfileResponse = {
  hotelContent?: Array<{
    hotelCode?: string;
    brandInfo?: {
      brandName?: string;
    };
    profile?: {
      name?: Array<{ locale?: string; value?: string }>;
      gdsName?: string;
      shortName?: string;
    };
    marketing?: {
      marketingText?: {
        seo?: {
          seoTitle?: Array<{ locale?: string; value?: string }>;
        };
      };
    };
  }>;
};

export type IhgApiMatch = {
  hotelCode: string;
  hotelName: string;
  confidence: number;
  sourceUrl: string;
  candidate: RateCandidate;
};

export class IhgApiClient {
  constructor(private readonly page: Page) {}

  async findPrice(input: PriceQuery): Promise<IhgApiMatch | undefined> {
    await this.ensureBrowserSession();

    const destination = await this.findDestination(input.hotelName);
    if (!destination?.latitude || !destination.longitude) {
      return undefined;
    }

    const offers = await this.searchOffers(input, destination);
    const openHotels = (offers.hotels ?? [])
      .filter((hotel) => hotel.hotelMnemonic && hotel.availabilityStatus === 'OPEN')
      .slice(0, 30);

    if (openHotels.length === 0) {
      return undefined;
    }

    const profiles = await Promise.all(
      openHotels.map(async (hotel) => ({
        hotel,
        profileName: await this.getProfileName(hotel.hotelMnemonic as string).catch(() => ''),
      })),
    );

    let best: IhgApiMatch | undefined;

    for (const item of profiles) {
      const hotelCode = item.hotel.hotelMnemonic as string;
      const hotelName = item.profileName || hotelCode;
      const confidence = nameConfidence(input.hotelName, hotelName);
      const candidate = this.toRateCandidate(item.hotel);

      if (!candidate.price) {
        continue;
      }

      if (!best || confidence > best.confidence) {
        best = {
          hotelCode,
          hotelName,
          confidence,
          sourceUrl: this.buildHotelUrl(hotelCode),
          candidate,
        };
      }
    }

    return best && best.confidence >= 0.35 ? best : undefined;
  }

  private async ensureBrowserSession(): Promise<void> {
    await this.page.goto(`${IHG_WEB_ORIGIN}/hotels/cn/zh/reservation`, {
      waitUntil: 'domcontentloaded',
    });
    await this.page.waitForTimeout(2_000);
  }

  private async findDestination(keyword: string): Promise<IhgDestination | undefined> {
    const url = `https://${IHG_API_HOST}/locations/v1/destinations?${new URLSearchParams({
      destination: keyword,
      chainCode: '6c',
    })}`;

    const data = await this.fetchJson<IhgDestination[]>(url, {
      method: 'GET',
    });

    return data.find((item) => item.latitude && item.longitude) ?? data[0];
  }

  private async searchOffers(input: PriceQuery, destination: IhgDestination): Promise<IhgOffersResponse> {
    const url = `https://${IHG_API_HOST}/availability/v3/hotels/offers?${new URLSearchParams({
      fieldset: 'summary,summary.rateRanges',
    })}`;

    return this.fetchJson<IhgOffersResponse>(url, {
      method: 'POST',
      body: {
        radius: Number(destination.searchRadius?.distance ?? 100),
        options: {
          summary: {
            returnTotalStayCost: true,
          },
        },
        maxRadius: 100,
        minHotels: 1,
        incrementRadiusBy: 70,
        distanceUnit: (destination.searchRadius?.unit ?? 'KM').toUpperCase(),
        distanceType: 'STRAIGHT_LINE',
        startDate: input.checkIn,
        endDate: input.checkOut,
        geoLocation: [
          {
            latitude: destination.latitude,
            longitude: destination.longitude,
          },
        ],
        products: [
          {
            productCode: 'SR',
            startDate: input.checkIn,
            endDate: input.checkOut,
            quantity: input.rooms,
            guestCounts: [
              {
                otaCode: 'AQC10',
                count: input.adults,
              },
            ],
          },
        ],
        rates: {
          ratePlanCodes: [
            {
              internal: 'IGCOR',
            },
          ],
        },
      },
    });
  }

  private async getProfileName(hotelCode: string): Promise<string> {
    const url = `https://${IHG_API_HOST}/hotels/v3/profiles/${hotelCode}/details`;
    const data = await this.fetchJson<IhgProfileResponse>(url, {
      method: 'GET',
    });
    const content = data.hotelContent?.[0];
    const localizedName = content?.profile?.name?.find((item) => item.value)?.value;
    const seoTitle = content?.marketing?.marketingText?.seo?.seoTitle?.find((item) => item.value)?.value;

    return localizedName
      ?? seoTitle
      ?? content?.profile?.gdsName
      ?? content?.profile?.shortName
      ?? hotelCode;
  }

  private toRateCandidate(hotel: IhgOfferHotel): RateCandidate {
    const lowest = hotel.totalStayLowestCashOnlyCost ?? hotel.lowestCashOnlyCost;
    const preferredRate = hotel.ratePlanDefinitions?.find((rate) => rate.code === 'IGCOR')
      ?? hotel.ratePlanDefinitions?.[0];
    const preferredMoney = preferredRate?.rateRange?.low;
    const money = preferredMoney ?? lowest;
    const description = preferredRate?.providerDescription ?? '';

    return {
      price: toNumber(money?.amountAfterTax ?? money?.baseAmount),
      currency: hotel.propertyCurrency,
      taxIncluded: Boolean(money?.amountAfterTax),
      rateName: preferredRate?.code,
      breakfastIncluded: /breakfast|早餐/i.test(description),
      isMemberRate: /member|会员|IHG One Rewards/i.test(description),
      isPrepaid: /prepay|prepaid|advance purchase|预付/i.test(description),
    };
  }

  private buildHotelUrl(hotelCode: string): string {
    return `${IHG_WEB_ORIGIN}/hotels/cn/zh/reservation/roomrate?hotelCode=${hotelCode}`;
  }

  private async fetchJson<T>(url: string, options: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    return this.page.evaluate(
      async ({ requestUrl, method, body, apiKey }) => {
        const response = await fetch(requestUrl, {
          method,
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'ihg-language': 'zh-CN',
            'ihg-sessionid': crypto.randomUUID(),
            'ihg-transactionid': crypto.randomUUID(),
            'x-ihg-api-key': apiKey,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`IHG API ${response.status}: ${text.slice(0, 500)}`);
        }

        return JSON.parse(text);
      },
      {
        requestUrl: url,
        method: options.method,
        body: options.body,
        apiKey: IHG_API_KEY,
      },
    ) as Promise<T>;
  }
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const number = Number(value.replace(/,/g, ''));
  return Number.isFinite(number) ? number : undefined;
}
