export const ctripSelectors = {
  homeUrl: 'https://hotels.ctrip.com/',
  hotelSearchInput: [
    'input[placeholder*="酒店"]',
    'input[placeholder*="目的地"]',
    'input[aria-label*="酒店"]',
  ],
  searchButton: [
    'button:has-text("搜索")',
    '[role="button"]:has-text("搜索")',
  ],
  hotelCards: [
    '[data-testid*="hotel"]',
    '.hotel-card',
    '.list-card',
  ],
  hotelName: [
    '[data-testid*="hotel-name"]',
    '.hotel-name',
    'h2',
    'h3',
  ],
  priceText: [
    '[class*="price"]',
    '[data-testid*="price"]',
    'text=/[¥￥][0-9,]+/',
  ],
};
