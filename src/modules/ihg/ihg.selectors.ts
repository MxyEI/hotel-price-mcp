export const ihgSelectors = {
  homeUrl: 'https://www.ihg.com/hotels/us/en/reservation',
  destinationInput: [
    'input[name="destination"]',
    'input[placeholder*="Destination"]',
    'input[aria-label*="Destination"]',
  ],
  searchButton: [
    'button:has-text("Search")',
    'button:has-text("SEARCH")',
    '[role="button"]:has-text("Search")',
  ],
  hotelCards: [
    '[data-testid*="hotel-card"]',
    '[class*="hotelCard"]',
    '[class*="hotel-card"]',
  ],
  hotelName: [
    '[data-testid*="hotel-name"]',
    'h2',
    'h3',
  ],
  priceText: [
    '[data-testid*="price"]',
    '[class*="price"]',
    'text=/\\$[0-9,]+/',
  ],
};
