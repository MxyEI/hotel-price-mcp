export const marriottSelectors = {
  homeUrl: 'https://www.marriott.com/default.mi',
  destinationInput: [
    'input[name="destinationAddress.destination"]',
    'input[placeholder*="Destination"]',
    'input[aria-label*="Destination"]',
  ],
  searchButton: [
    'button:has-text("Find Hotels")',
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
  ],
};
