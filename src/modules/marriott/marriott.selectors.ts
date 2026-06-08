export const marriottSelectors = {
  homeUrl: 'https://www.marriott.com.cn/default.mi',
  destinationInput: [
    'input[name="destinationAddress.destination"]',
    'input[placeholder*="Destination"]',
    'input[placeholder*="目的地"]',
    'input[aria-label*="Destination"]',
  ],
  searchButton: [
    'button:has-text("Find Hotels")',
    'button:has-text("查找酒店")',
    'button:has-text("Search")',
    '[role="button"]:has-text("Find Hotels")',
  ],
  hotelCards: [
    '[data-testid*="property-card"]',
    '[class*="property-card"]',
    '[class*="hotel-card"]',
  ],
  hotelName: [
    '[data-testid*="property-name"]',
    'h2',
    'h3',
  ],
  priceText: [
    '[data-testid*="rate"]',
    '[class*="price"]',
    '[class*="rate"]',
    'text=/\\$[0-9,]+/',
    'text=/[¥￥][0-9,]+/',
  ],
};
