export const hyattSelectors = {
  searchBase: 'https://www.hyatt.com/search/hotels/zh-CN',
  homeUrl: 'https://www.hyatt.com/zh-CN',
  hotelCards: [
    '[data-js="hotel-card"]',
  ],
  hotelName: [
    '[id*="map-result-card-title"]',
  ],
  cookieBanner: [
    '#onetrust-accept-btn-handler',
  ],
  spiritCode: 'data-spirit-code',
  brand: 'data-brand',
  bookingStatus: 'data-booking-status',
  distance: 'data-distance-from-centerpoint',
  latitude: 'data-latitude',
  longitude: 'data-longitude',
};
