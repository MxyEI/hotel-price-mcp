export const ctripSelectors = {
  // 直接用搜索结果页 URL，绕过首页表单填写
  searchUrl(hotelName: string, checkIn: string, checkOut: string, adults: number): string {
    const params = new URLSearchParams({
      keyword: hotelName,
      checkin: checkIn.replace(/-/g, '/'),
      checkout: checkOut.replace(/-/g, '/'),
      adult: String(adults),
      searchBoxArg: 't',
    });
    return `https://hotels.ctrip.com/hotels/list?${params}`;
  },

  // API 响应匹配
  apiResponsePattern: /\/api\/hotels\/|hotel\/list|hotelSearch|\/restapi\/soa2\//i,

  // DOM 选择器 — 宽泛匹配，按优先级排列
  hotelCards: [
    '[id^="hotel_"]',
    'div[data-hotelid]',
    '[class*="hotelItem"]',
    '[class*="HotelItem"]',
    '[class*="hotel-item"]',
    '[class*="list_item"]',
    '[class*="ListItem"]',
    'li[class*="hotel"]',
  ],
  hotelName: [
    'a[class*="name"]',
    '[class*="hotelName"]',
    '[class*="HotelName"]',
    '[class*="hotel_name"]',
    'a[target="_blank"][title]',
    'h2',
    'h3',
    'a[href*="/hotels/"]',
  ],
  priceText: [
    '[class*="price"]',
    '[class*="Price"]',
    'span[class*="real"]',
    'dfn + span',
    'text=/[¥￥][0-9,]+/',
  ],
};
