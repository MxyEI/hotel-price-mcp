import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Page } from 'playwright-core';
import { env } from '../config/env.js';
import { closeCloakProxy, prepareCloakProxy } from './cloakClient.js';

export type ManualBrowserStatus = 'starting' | 'open' | 'closed' | 'error';

export type ManualBrowserSession = {
  id: string;
  status: ManualBrowserStatus;
  provider: string;
  targetUrl: string;
  currentUrl?: string;
  fingerprintSeed?: number;
  profileDir: string;
  startedAt: string;
  closedAt?: string;
  errorMessage?: string;
  context?: BrowserContext;
  page?: Page;
  anonymizedProxyUrl?: string;
};

export type ManualBrowserStartInput = {
  provider?: string;
  targetUrl?: string;
  hotelName?: string;
  checkIn?: string;
  checkOut?: string;
  rooms?: number;
  adults?: number;
  children?: number;
};

const sessions = new Map<string, ManualBrowserSession>();
const MARRIOTT_DEFAULT_URL = 'https://www.marriott.com/default.mi';

export class ManualBrowserService {
  async start(input: ManualBrowserStartInput = {}): Promise<ManualBrowserSession> {
    if (env.CLOAK_REQUIRE_PROXY && !env.CLOAK_PROXY_URL) {
      throw new Error('CLOAK_PROXY_URL is required when CLOAK_REQUIRE_PROXY=true');
    }

    const sessionId = `mb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fingerprintSeed = env.CLOAK_FINGERPRINT_ROTATE ? randomFingerprintSeed() : undefined;
    const provider = input.provider ?? 'marriott';
    const targetUrl = input.targetUrl ?? buildProviderUrl(provider, input);
    const profileDir = path.resolve(env.ARTIFACT_DIR, 'manual-browser-profiles', sessionId);

    await mkdir(profileDir, { recursive: true });

    const session: ManualBrowserSession = {
      id: sessionId,
      status: 'starting',
      provider,
      targetUrl,
      fingerprintSeed,
      profileDir,
      startedAt: new Date().toISOString(),
    };
    sessions.set(sessionId, session);

    void this.openSession(session).catch((error) => {
      session.status = 'error';
      session.errorMessage = error instanceof Error ? error.message : String(error);
      session.closedAt = new Date().toISOString();
    });

    return session;
  }

  get(sessionId: string): ManualBrowserSession | undefined {
    const session = sessions.get(sessionId);
    if (session?.page) {
      session.currentUrl = session.page.url();
    }
    return session;
  }

  list(): ManualBrowserSession[] {
    return [...sessions.values()].map((session) => {
      if (session.page) {
        session.currentUrl = session.page.url();
      }
      return session;
    });
  }

  async close(sessionId: string): Promise<boolean> {
    const session = sessions.get(sessionId);
    if (!session) {
      return false;
    }

    await this.closeSession(session);
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...sessions.values()].map((session) => this.closeSession(session)));
  }

  private async openSession(session: ManualBrowserSession): Promise<void> {
    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
    ];

    if (session.fingerprintSeed) {
      args.push(`--fingerprint=${session.fingerprintSeed}`);
    }

    let proxy: string | undefined;
    let geoip = env.CLOAK_GEOIP;

    if (env.CLOAK_PROXY_URL) {
      const prepared = await prepareCloakProxy(env.CLOAK_PROXY_URL);
      proxy = prepared.proxyUrl;
      geoip = prepared.geoip;
      session.anonymizedProxyUrl = prepared.anonymizedProxyUrl;
    }

    const context = await launchPersistentContext({
      userDataDir: session.profileDir,
      headless: false,
      humanize: env.CLOAK_HUMANIZE,
      geoip,
      proxy,
      args,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      viewport: null,
      colorScheme: 'light',
    });

    session.context = context;
    context.on('close', () => {
      session.status = 'closed';
      session.closedAt = new Date().toISOString();
      void closeCloakProxy({ anonymizedProxyUrl: session.anonymizedProxyUrl });
    });

    const page = context.pages()[0] ?? await context.newPage();
    session.page = page;
    await page.goto(session.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((error) => {
      session.errorMessage = error instanceof Error ? error.message : String(error);
    });
    session.currentUrl = page.url();
    session.status = 'open';
  }

  private async closeSession(session: ManualBrowserSession): Promise<void> {
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    await session.context?.close().catch(() => undefined);
    session.context = undefined;
    session.page = undefined;
    await closeCloakProxy({ anonymizedProxyUrl: session.anonymizedProxyUrl });
    sessions.delete(session.id);
  }
}

function buildProviderUrl(provider: string, input: ManualBrowserStartInput): string {
  if (provider !== 'marriott') {
    return input.targetUrl ?? MARRIOTT_DEFAULT_URL;
  }

  if (!input.hotelName || !input.checkIn || !input.checkOut) {
    return MARRIOTT_DEFAULT_URL;
  }

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
    roomCount: String(input.rooms ?? 1),
    numAdultsPerRoom: String(input.adults ?? 2),
    childrenCount: String(input.children ?? 0),
    deviceType: 'desktop-web',
    view: 'list',
    currentOffset: '0',
  });

  return `https://www.marriott.com/search/findHotels.mi?${params}`;
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

function randomFingerprintSeed(): number {
  const min = env.CLOAK_FINGERPRINT_MIN;
  const max = env.CLOAK_FINGERPRINT_MAX;

  if (max <= min) {
    return min;
  }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}
