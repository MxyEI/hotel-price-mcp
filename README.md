# hotel-price-mcp
酒店自动查价 携程 洲际 万豪


## 当前实现

这是一个 Node.js / TypeScript 查价服务骨架，使用 `cloakbrowser` 启动浏览器，并把携程、洲际、万豪拆成三个独立 provider 模块。

目录：

```text
src/
  app.ts                         HTTP 服务入口
  browser/                       CloakBrowser 启动、浏览器池、页面辅助函数
  modules/
    base/                        统一输入输出类型、价格解析和酒店名称匹配
    ctrip/                       携程查价模块
    ihg/                         洲际查价模块
    marriott/                    万豪查价模块
  services/PriceQueryService.ts  聚合三个 provider
  api/routes.ts                  REST API
  storage/priceRepository.ts     查询记录内存仓库
```

## 安装

```bash
npm install
cp .env.example .env
```

## 启动

```bash
npm run dev
```

默认监听 `http://localhost:3100`。

## 查询接口

```bash
curl -X POST http://localhost:3100/price/query \
  -H 'Content-Type: application/json' \
  -d '{
    "hotelName": "上海静安瑞吉酒店",
    "checkIn": "2026-07-01",
    "checkOut": "2026-07-02",
    "rooms": 1,
    "adults": 2
  }'
```

返回结构：

```json
{
  "queryId": "q_xxx",
  "results": [
    {
      "provider": "ctrip",
      "hotelName": "上海静安瑞吉酒店",
      "checkIn": "2026-07-01",
      "checkOut": "2026-07-02",
      "available": true,
      "lowestPrice": 1680,
      "currency": "CNY",
      "status": "success",
      "queriedAt": "2026-06-05T00:00:00.000Z"
    }
  ]
}
```

## 配置

`.env` 支持：

```text
PORT=3100
LOG_LEVEL=info
CLOAK_HEADLESS=false
CLOAK_HUMANIZE=true
CLOAK_GEOIP=true
CLOAK_PROXY_URL=
QUERY_TIMEOUT_MS=90000
ARTIFACT_DIR=.artifacts
```

强风控页面建议保持 `CLOAK_HEADLESS=false` 和 `CLOAK_HUMANIZE=true`，如需代理则设置 `CLOAK_PROXY_URL`。

## 后续落地重点

三个 provider 已经按站点分离，真实上线前需要用实际酒店样例逐站调试页面选择器：

- 携程：`src/modules/ctrip/ctrip.selectors.ts`
- 洲际：`src/modules/ihg/ihg.selectors.ts`
- 万豪：`src/modules/marriott/marriott.selectors.ts`

查询失败时会把截图保存到 `.artifacts/<provider>/`，用于定位验证码、风控、酒店未匹配或页面结构变化。
