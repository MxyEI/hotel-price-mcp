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

/**
 * 页面内 JS 拦截器 — 在浏览器内部拦截 fetch/XHR 响应，
 * 避免 Playwright response.text() 读取失败的问题。
 */
const NETWORK_INTERCEPTOR_SCRIPT = `
  window.__marriottCaptured = [];

  function __marriottTryCapture(url, text) {
    if (!url || !text) return;
    try {
      const data = JSON.parse(text);
      window.__marriottCaptured.push({ url, data });
    } catch(e) {}
  }

  // 拦截 fetch
  const __originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const resp = await __originalFetch.apply(this, args);
    if (url && !url.includes('hotelads') && !url.includes('google') && !url.includes('doubleclick')) {
      try {
        const clone = resp.clone();
        clone.text().then(t => __marriottTryCapture(url, t)).catch(() => {});
      } catch(e) {}
    }
    return resp;
  };

  // 拦截 XMLHttpRequest
  const __originalXHROpen = XMLHttpRequest.prototype.open;
  const __originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__captureUrl = url;
    return __originalXHROpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      if (this.__captureUrl && !this.__captureUrl.includes('hotelads') && !this.__captureUrl.includes('google')) {
        __marriottTryCapture(this.__captureUrl, this.responseText);
      }
    });
    return __originalXHRSend.apply(this, args);
  };
`;

export class MarriottApiClient {
  private readonly apiPayloads: unknown[] = [];
  private cookieWatcherTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly page: Page) {}

  private log(msg: string): void {
    console.error(`[marriott] ${msg}`);
  }

  async findPrice(input: PriceQuery): Promise<MarriottApiMatch | undefined> {
    this.log('开始查价流程');

    // 注入页面内网络拦截器（在所有导航之前生效）
    await this.installNetworkInterceptor();
    this.log('已注入网络拦截器');

    // 启动 Cookie 弹窗后台监控（每 1.5 秒检测一次，出现就自动点击）
    this.startCookieWatcher();
    this.log('Cookie 弹窗监控已启动');

    try {
      await this.captureApiResponses(async () => {
        await this.navigateViaSearchForm(input);
      });

      // 合并三个数据源
      const injectedPayloads = await this.collectInjectedPayloads();
      const allPayloads = [...this.apiPayloads, ...injectedPayloads];
      this.log(`数据收集完成: Playwright拦截=${this.apiPayloads.length}, JS拦截=${injectedPayloads.length}`);

      const candidates = [
        ...this.extractCandidatesFromPayloads(input, allPayloads),
        ...await this.extractCandidatesFromPageState(input).catch(() => []),
      ];
      this.log(`候选酒店数量: ${candidates.length}`);

      return this.pickBestCandidate(input, candidates);
    } finally {
      this.stopCookieWatcher();
      this.log('Cookie 弹窗监控已停止');
    }
  }

  /**
   * 启动后台定时器，每 1.5 秒检测 Cookie 弹窗，出现即自动点击「接受所有 Cookie」。
   * 使用 Playwright locator click 而非 evaluate，在导航期间更稳定。
   */
  private startCookieWatcher(): void {
    this.stopCookieWatcher();
    this.cookieWatcherTimer = setInterval(async () => {
      try {
        // 检查页面是否还活着
        const url = this.page.url();
        if (!url) return;

        // 用 locator 检测按钮是否可见并点击
        const btn = this.page.locator('#onetrust-accept-btn-handler');
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click({ timeout: 3_000 }).catch(() => {});
          this.log('✓ Cookie 弹窗已自动点击关闭');
          return;
        }

        // 备选：在 banner 内找按钮
        const bannerBtn = this.page.locator('#onetrust-banner-sdk button:has-text("接受所有")');
        const bannerVisible = await bannerBtn.isVisible().catch(() => false);
        if (bannerVisible) {
          await bannerBtn.click({ timeout: 3_000 }).catch(() => {});
          this.log('✓ Cookie 弹窗已自动点击关闭 (banner btn)');
          return;
        }
      } catch {
        // 页面导航中或已关闭，忽略
      }
    }, 1_500);
  }

  /**
   * 停止 Cookie 弹窗后台监控。
   */
  private stopCookieWatcher(): void {
    if (this.cookieWatcherTimer) {
      clearInterval(this.cookieWatcherTimer);
      this.cookieWatcherTimer = null;
    }
  }

  /**
   * 注入页面内 JS 拦截器。使用 addInitScript 确保在每次导航时自动注入，
   * 能捕获 Playwright response.text() 无法读取的受保护响应。
   */
  private async installNetworkInterceptor(): Promise<void> {
    const context = this.page.context();
    await context.addInitScript(NETWORK_INTERCEPTOR_SCRIPT);
  }

  /**
   * 模拟真实用户操作：打开首页 → 填写目的地/日期 → 点击搜索。
   * 页面内部触发的导航不会被 Akamai 拦截。
   */
  private async navigateViaSearchForm(input: PriceQuery): Promise<void> {
    // 1. 打开首页（不带参数）
    this.log('步骤1: 打开万豪首页...');
    await this.page.goto(MARRIOTT_HOME, { waitUntil: 'commit', timeout: 60_000 });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => undefined);
    this.log(`步骤1: 首页已加载, URL=${this.page.url()}`);
    await this.page.waitForTimeout(3_000 + Math.random() * 2_000);

    // 2. 模拟人类行为
    this.log('步骤2: 模拟鼠标移动...');
    await this.page.mouse.move(300 + Math.random() * 400, 200 + Math.random() * 200);
    await this.page.waitForTimeout(500 + Math.random() * 500);

    // 3. 填写目的地（最多重试 2 次）
    this.log('步骤3: 开始填写目的地...');
    let formFilled = false;
    for (let attempt = 0; attempt < 2 && !formFilled; attempt++) {
      if (attempt > 0) {
        this.log('步骤3: 重试填写目的地...');
        await this.page.waitForTimeout(2_000);
      }
      formFilled = await this.fillSearchForm(input);
    }

    if (!formFilled) {
      throw new Error('无法填写万豪搜索表单，目的地输入框未找到');
    }

    // 4. 选择日期
    this.log('步骤4: 选择日期...');
    await this.fillDates(input.checkIn, input.checkOut);

    // 5. 点击搜索按钮
    this.log('步骤5: 点击搜索按钮...');
    await this.clickSearchButton();

    // 6. 等待页面响应
    this.log('步骤6: 等待页面响应...');
    await this.page.waitForTimeout(5_000 + Math.random() * 3_000);
    await this.page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);

    // 7. 检测是否被 Akamai 拦截，如果被拦截就刷新页面
    const blocked = await this.detectAndRecoverFromBlock();
    if (blocked) {
      this.log('步骤7: 检测到被拦截，已通过刷新恢复');
    }

    // 8. 等待搜索结果加载完成
    const currentUrl = this.page.url();
    this.log(`步骤8: 当前URL = ${currentUrl}`);
    await this.page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    await this.page.waitForTimeout(3_000 + Math.random() * 2_000);

    // 9. 尝试点击「更新搜索」触发 GraphQL 请求
    await this.clickUpdateSearchIfPresent();
    await this.page.waitForTimeout(2_000 + Math.random() * 2_000);
    this.log('搜索流程完成');
  }

  private formatMarriottDate(isoDate: string): string {
    const [year, month, day] = isoDate.split('-');
    return `${month}/${day}/${year}`;
  }

  private calcNights(checkIn: string, checkOut: string): number {
    const start = Date.parse(`${checkIn}T00:00:00Z`);
    const end = Date.parse(`${checkOut}T00:00:00Z`);
    const nights = Math.round((end - start) / 86_400_000);
    return nights > 0 ? nights : 1;
  }

  /**
   * 检测 Akamai Access Denied 拦截页面，如果检测到就自动刷新。
   * 手动刷新后 Akamai 会放行（因为 referer 变成了同域页面）。
   * 最多尝试刷新 3 次。
   */
  private async detectAndRecoverFromBlock(): Promise<boolean> {
    let recovered = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const isBlocked = await this.page.evaluate(() => {
        const body = document.body?.innerText || '';
        return body.includes('Access Denied') || body.includes('You don\'t have permission');
      }).catch(() => false);

      if (!isBlocked) {
        return recovered;
      }

      this.log(`  ⚠ 检测到 Access Denied，第 ${attempt + 1} 次刷新页面...`);
      recovered = true;

      // 刷新页面（相当于手动 F5）
      await this.page.reload({ waitUntil: 'commit', timeout: 60_000 }).catch(() => undefined);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => undefined);
      await this.page.waitForTimeout(3_000 + Math.random() * 2_000);
      await this.page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
      await this.page.waitForTimeout(2_000 + Math.random() * 1_000);
    }

    return recovered;
  }

  /**
   * 填写万豪首页搜索表单。
   * 基于实际 DOM 结构：
   *   目的地输入框: #downshift-*-input 或 [data-testid="shop-SearchField"] input
   *   搜索按钮: .update-search-btn 或 data-custom_click_track_value 含 "Find Hotels"
   *   日期: [aria-label="date-picker"] (readonly, 需点击打开日期面板)
   */
  private async fillSearchForm(input: PriceQuery): Promise<boolean> {
    try {
      // 等待搜索表单容器出现
      const formSelector = '[data-testid="searchform"], [data-component-name="o-shop-searchform"]';
      this.log('  等待搜索表单容器...');
      await this.page.waitForSelector(formSelector, { timeout: 30_000 });
      this.log('  ✓ 搜索表单容器已出现');
      await this.page.waitForTimeout(1_000 + Math.random() * 1_000);

      // 找到目的地输入框
      const destSelector = [
        'input[id^="downshift-"][id$="-input"]',
        '[data-testid="shop-SearchField"] input[type="text"]',
        'input[placeholder*="您要去哪里"]',
        'input[placeholder*="Where are you going"]',
      ].join(', ');

      const destInput = this.page.locator(destSelector).first();
      this.log('  等待目的地输入框...');
      await destInput.waitFor({ state: 'visible', timeout: 15_000 });
      this.log('  ✓ 目的地输入框已出现');

      // 点击输入框获取焦点
      await destInput.click();
      this.log('  ✓ 已点击目的地输入框');
      await this.page.waitForTimeout(500 + Math.random() * 300);

      // 清空当前值并逐字输入酒店名称
      await destInput.fill('');
      await this.page.waitForTimeout(300);
      this.log(`  输入酒店名称: "${input.hotelName}"...`);
      await destInput.pressSequentially(input.hotelName, { delay: 80 + Math.random() * 60 });
      this.log('  ✓ 酒店名称输入完成');
      await this.page.waitForTimeout(2_000 + Math.random() * 1_000);

      // 等待自动补全下拉出现，选择第一项
      this.log('  等待自动补全下拉...');
      await this.selectAutocompleteOrDismiss();

      this.log('  ✓ 表单填写完成');
      return true;
    } catch (error) {
      this.log(`  ✗ fillSearchForm 失败: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /**
   * 等待自动补全下拉列表，选择第一项。
   * 万豪使用 downshift 组件，下拉项为 [role="option"] 或 li。
   */
  private async selectAutocompleteOrDismiss(): Promise<void> {
    try {
      const autocompleteSelector = '[role="listbox"] [role="option"], [id^="downshift-"][id$="-menu"] li, [class*="suggestion"] li, [class*="autocomplete"] li';
      const firstOption = this.page.locator(autocompleteSelector).first();
      await firstOption.waitFor({ state: 'visible', timeout: 5_000 });
      await this.page.waitForTimeout(300 + Math.random() * 300);
      await firstOption.click();
      this.log('  ✓ 已选择自动补全第一项');
      await this.page.waitForTimeout(800 + Math.random() * 500);
    } catch {
      this.log('  自动补全未出现，按 Escape 继续');
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * 选择入住/离店日期。
   * 步骤：点击日期区域 → 打开日历面板 → 点击入住日 → 点击离店日 → 确认。
   * 日志会输出日历面板的关键信息用于调试。
   */
  private async fillDates(checkIn: string, checkOut: string): Promise<void> {
    try {
      // 点击日期输入区域打开日历面板
      const dateFieldSelector = '[data-testid="shop-DatePicker"], [data-component-name="m-shop-DatePicker"], .date-picker-wrapper';
      const dateField = this.page.locator(dateFieldSelector).first();
      const isVisible = await dateField.isVisible().catch(() => false);

      if (!isVisible) {
        this.log('  ✗ 日期区域不可见，跳过日期设置');
        return;
      }

      await dateField.click();
      this.log('  ✓ 已点击日期区域');
      await this.page.waitForTimeout(1_500 + Math.random() * 500);

      // 输出日历面板的 DOM 信息用于调试
      const calendarInfo = await this.page.evaluate(() => {
        // 查找日历弹窗/面板
        const possiblePanels = document.querySelectorAll('[class*="datepicker"], [class*="DatePicker"], [class*="calendar"], [class*="Calendar"], [role="dialog"]');
        for (const panel of possiblePanels) {
          const html = panel.innerHTML;
          if (html.length > 200 && (html.includes('aria-label') || panel.querySelectorAll('td, [role="gridcell"]').length > 10)) {
            // 获取所有可点击的日期元素信息
            const days: Array<{ text: string; ariaLabel: string; tag: string; classes: string }> = [];
            const cells = panel.querySelectorAll('td:not([aria-disabled="true"]), [role="gridcell"]:not([aria-disabled="true"]), button[aria-label]');
            for (const cell of Array.from(cells).slice(0, 10)) {
              days.push({
                text: (cell.textContent || '').trim().substring(0, 20),
                ariaLabel: cell.getAttribute('aria-label') || '',
                tag: cell.tagName.toLowerCase(),
                classes: (cell.className || '').substring(0, 60),
              });
            }
            return { found: true, panelClass: (panel as HTMLElement).className.substring(0, 100), daysSample: days };
          }
        }
        return { found: false, panelClass: '', daysSample: [] };
      });

      this.log(`  日历面板: found=${calendarInfo.found}, class="${calendarInfo.panelClass}"`);
      if (calendarInfo.daysSample.length > 0) {
        this.log(`  日期元素示例: ${JSON.stringify(calendarInfo.daysSample.slice(0, 3))}`);
      }

      if (!calendarInfo.found) {
        this.log('  ✗ 日历面板未出现，跳过日期设置');
        await this.page.keyboard.press('Escape').catch(() => {});
        return;
      }

      // 解析目标日期
      const [checkInYear, checkInMonth, checkInDay] = checkIn.split('-').map(Number);
      const [checkOutYear, checkOutMonth, checkOutDay] = checkOut.split('-').map(Number);

      // 选择入住日期
      const checkinOk = await this.clickDateCell(checkInYear, checkInMonth, checkInDay);
      this.log(`  入住 ${checkIn}: ${checkinOk ? '✓' : '✗'}`);
      await this.page.waitForTimeout(800 + Math.random() * 400);

      // 选择离店日期
      const checkoutOk = await this.clickDateCell(checkOutYear, checkOutMonth, checkOutDay);
      this.log(`  离店 ${checkOut}: ${checkoutOk ? '✓' : '✗'}`);
      await this.page.waitForTimeout(800 + Math.random() * 400);

      // 关闭日历：点确认按钮或按 Escape
      const doneClicked = await this.page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').trim();
          if ((text === '完成' || text === 'Done' || text === '确定' || text === 'Apply') && (btn as HTMLElement).offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (doneClicked) {
        this.log('  ✓ 已关闭日历面板');
      } else {
        await this.page.keyboard.press('Escape').catch(() => {});
        this.log('  按 Escape 关闭日历');
      }
      await this.page.waitForTimeout(500 + Math.random() * 300);
    } catch (error) {
      this.log(`  日期设置异常: ${error instanceof Error ? error.message : error}`);
      await this.page.keyboard.press('Escape').catch(() => {});
    }
  }

  /**
   * 在日历面板中点击指定日期。
   * 尝试多种策略：aria-label 匹配、data-date 匹配、文本数字匹配。
   */
  private async clickDateCell(year: number, month: number, day: number): Promise<boolean> {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    return this.page.evaluate(({ year, month, day, dateStr }) => {
      // 策略 1：通过 aria-label 匹配（万豪常见格式："6月 15日, 周日" 或 "2026年6月15日"）
      const allClickable = document.querySelectorAll('td, [role="gridcell"], button, div[role="button"]');
      for (const el of allClickable) {
        const aria = el.getAttribute('aria-label') || '';
        const dataDate = el.getAttribute('data-date') || el.getAttribute('data-day') || '';

        // aria-label 包含月和日
        if (aria && aria.includes(`${month}月`) && (aria.includes(`${day}日`) || aria.includes(` ${day},`) || aria.includes(` ${day} `))) {
          if ((el as HTMLElement).offsetHeight > 0 && el.getAttribute('aria-disabled') !== 'true') {
            (el as HTMLElement).click();
            return true;
          }
        }

        // data-date 精确匹配 YYYY-MM-DD
        if (dataDate === dateStr) {
          if ((el as HTMLElement).offsetHeight > 0) {
            (el as HTMLElement).click();
            return true;
          }
        }
      }

      // 策略 2：文本数字匹配（在日历面板范围内）
      const panels = document.querySelectorAll('[class*="datepicker"], [class*="DatePicker"], [class*="calendar"], [class*="Calendar"]');
      for (const panel of panels) {
        if (panel.innerHTML.length < 200) continue;
        const cells = panel.querySelectorAll('td, [role="gridcell"], button');
        for (const cell of cells) {
          const text = (cell.textContent || '').trim();
          if (text === String(day) && (cell as HTMLElement).offsetHeight > 0 && cell.getAttribute('aria-disabled') !== 'true') {
            (cell as HTMLElement).click();
            return true;
          }
        }
      }

      return false;
    }, { year, month, day, dateStr });
  }

  /**
   * 点击「查找酒店」搜索按钮。
   */
  private async clickSearchButton(): Promise<void> {
    try {
      // 精确选择器：万豪搜索按钮有 .update-search-btn class
      const btnSelector = '.update-search-btn, button[data-custom_click_track_value*="Find Hotels"], [data-testid="searchform"] button.m-button-primary-icon';
      const searchBtn = this.page.locator(btnSelector).first();
      const visible = await searchBtn.isVisible().catch(() => false);

      if (visible) {
        await searchBtn.click();
        this.log('  ✓ 已点击搜索按钮 (.update-search-btn)');
        await this.page.waitForTimeout(1_000);
        return;
      }
    } catch {
      // 精确选择器失败
    }

    // 降级：通过文本匹配查找
    const clicked = await this.page.evaluate(() => {
      const searchTexts = ['查找酒店', 'Find Hotels'];
      const candidates = document.querySelectorAll('button');
      for (const el of candidates) {
        const text = (el.textContent || '').trim();
        for (const st of searchTexts) {
          if (text.includes(st)) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });

    if (clicked) {
      this.log('  ✓ 已点击搜索按钮 (文本匹配)');
    } else {
      this.log('  ✗ 未找到搜索按钮，按 Enter 尝试');
      await this.page.keyboard.press('Enter');
    }
    await this.page.waitForTimeout(1_000);
  }

  /**
   * 在结果页上点击「更新搜索」按钮（如果存在）。
   */
  private async clickUpdateSearchIfPresent(): Promise<void> {
    try {
      const clicked = await this.page.evaluate(() => {
        const texts = ['更新搜索', 'Update Search'];
        const els = document.querySelectorAll('button, a, [role="button"], .btn');
        for (const el of els) {
          if (!(el as HTMLElement).offsetParent) continue;
          const text = (el.textContent || '').trim();
          for (const t of texts) {
            if (text === t || text.startsWith(t)) {
              (el as HTMLElement).click();
              return true;
            }
          }
        }
        return false;
      });
      if (clicked) {
        this.log('  ✓ 已点击「更新搜索」按钮');
        await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        await this.page.waitForTimeout(2_000 + Math.random() * 1_000);
      } else {
        this.log('  未发现「更新搜索」按钮，跳过');
      }
    } catch {
      // 忽略
    }
  }

  /**
   * 从页面内 JS 拦截器收集捕获到的 API 响应。
   */
  private async collectInjectedPayloads(): Promise<unknown[]> {
    try {
      const captured = await this.page.evaluate(() => {
        return (window as any).__marriottCaptured || [];
      }) as Array<{ url: string; data: unknown }>;

      // 打印 phoenixShopDatedSearchByGeoQuery 的 JS 拦截结果
      for (const entry of captured) {
        if (typeof entry.url === 'string' && entry.url.includes('phoenixShopDatedSearchByGeoQuery')) {
          this.log(`━━━ JS拦截器捕获到 phoenixShopDatedSearchByGeoQuery ━━━`);
          this.log(`  URL: ${entry.url}`);
          const jsonStr = JSON.stringify(entry.data).substring(0, 2000);
          this.log(`  响应内容:\n${jsonStr}`);
          this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        }
      }

      return captured
        .filter((entry) => entry.data && typeof entry.data === 'object')
        .map((entry) => entry.data);
    } catch {
      return [];
    }
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

        // 专门打印 phoenixShopDatedSearchByGeoQuery 接口的响应
        if (url.includes('phoenixShopDatedSearchByGeoQuery')) {
          this.log(`━━━ 捕获到 phoenixShopDatedSearchByGeoQuery 响应 ━━━`);
          this.log(`  URL: ${url}`);
          this.log(`  Status: ${response.status()}`);
          this.log(`  Content-Type: ${contentType}`);
          this.log(`  响应长度: ${text.length} 字符`);
          // 打印前 2000 字符
          this.log(`  响应内容:\n${text.substring(0, 2000)}`);
          if (text.length > 2000) {
            this.log(`  ... (截断，共 ${text.length} 字符)`);
          }
          this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        }

        if (!text.includes(SEARCH_RESULT_TYPENAME) && !looksLikeJson(text)) {
          return;
        }

        const parsed = parsePossibleJson(text);
        if (parsed) {
          this.apiPayloads.push(parsed);
        }
      } catch {
        // Some protected or streaming responses cannot be read via Playwright.
        // The injected JS interceptor will capture these instead.
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
        if (text.includes('SearchLowestAvailableRates') || text.includes('lowestAvailableRates')) {
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
