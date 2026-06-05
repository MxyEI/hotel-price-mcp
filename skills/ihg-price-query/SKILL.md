# IHG Price Query

Use this skill when the user asks to query IHG / InterContinental / Holiday Inn / Crowne Plaza / HUALUXE hotel prices by hotel name and stay dates.

## Tool

Prefer the MCP tool:

```text
ihg_query_price
```

Input:

```json
{
  "hotelName": "西安经开洲际",
  "checkIn": "2026-07-01",
  "checkOut": "2026-07-02",
  "rooms": 1,
  "adults": 2,
  "children": 0
}
```

Output is a JSON hotel price result with:

```text
provider
hotelName
matchedHotelName
matchConfidence
checkIn
checkOut
available
lowestPrice
currency
taxIncluded
rateName
sourceUrl
status
errorMessage
```

## Behavior

- Use the MCP result as source of truth.
- If `status` is `success`, report matched hotel name, date range, lowest price, currency, tax inclusion, and source URL.
- If `status` is `hotel_not_found`, ask for a more exact IHG hotel name.
- If `status` is `captcha`, `blocked`, or `error`, report the error message and do not invent a price.
- If the user gives relative dates, convert them to `YYYY-MM-DD` before calling the tool.

## Requirements

The MCP server requires a configured proxy in the project `.env`:

```text
CLOAK_REQUIRE_PROXY=true
CLOAK_PROXY_URL=socks5://user:pass@host:port
```

The implementation starts a new CloakBrowser instance for each query and rotates the fingerprint seed.
