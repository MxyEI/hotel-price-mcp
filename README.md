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

## IHG MCP 工具

洲际查价也提供 stdio MCP server，适合 Claude、Codex、OpenClaw、Hermes 等支持 MCP 的 Agent 客户端调用。

先构建：

```bash
npm run build
```

MCP 启动命令：

```bash
node /Users/apple/PycharmProjects/hotel-price-mcp/dist/mcp/ihgMcpServer.js
```

工具名：

```text
ihg_query_price
```

工具输入：

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

MCP 配置示例：

[config/mcp.ihg.example.json](config/mcp.ihg.example.json)

同时提供一份可移植 skill 说明：

[skills/ihg-price-query/SKILL.md](skills/ihg-price-query/SKILL.md)

## 配置

`.env` 支持：

```text
PORT=3100
LOG_LEVEL=info
CLOAK_HEADLESS=false
CLOAK_HUMANIZE=true
CLOAK_GEOIP=true
CLOAK_REQUIRE_PROXY=true
CLOAK_PROXY_URL=http://user:pass@host:port
CLOAK_FINGERPRINT_ROTATE=true
CLOAK_FINGERPRINT_MIN=10000
CLOAK_FINGERPRINT_MAX=999999999
QUERY_TIMEOUT_MS=90000
ARTIFACT_DIR=.artifacts
```

强风控页面建议保持 `CLOAK_HEADLESS=false`、`CLOAK_HUMANIZE=true` 和 `CLOAK_GEOIP=true`。

默认要求必须配置代理：

```text
CLOAK_REQUIRE_PROXY=true
CLOAK_PROXY_URL=http://user:pass@host:port
```

支持 HTTP 和 SOCKS5：

```text
http://user:pass@host:port
socks5://user:pass@host:port
```

带账号密码的 SOCKS5 代理会自动通过本地 HTTP 代理桥转发，因为 Chromium 不支持直接使用 `socks5://user:pass@host:port` 形式的代理认证。此模式下会关闭自动 GeoIP，避免首次下载 GeoIP 数据库拖慢查询。

每次查价都会启动一个新的 CloakBrowser 实例，并随机生成新的指纹 seed：

```text
CLOAK_FINGERPRINT_ROTATE=true
CLOAK_FINGERPRINT_MIN=10000
CLOAK_FINGERPRINT_MAX=999999999
```

如果需要固定指纹排查问题，可以临时设置 `CLOAK_FINGERPRINT_ROTATE=false`。

## 后续落地重点

三个 provider 已经按站点分离，真实上线前需要用实际酒店样例逐站调试页面选择器：

- 携程：`src/modules/ctrip/ctrip.selectors.ts`
- 洲际：`src/modules/ihg/ihg.selectors.ts`
- 万豪：`src/modules/marriott/marriott.selectors.ts`

查询失败时会把截图保存到 `.artifacts/<provider>/`，用于定位验证码、风控、酒店未匹配或页面结构变化。

### IHG 接口模式

洲际模块已经改为接口取数，不再依赖页面 DOM 抽价格：

1. 用 CloakBrowser 打开 `www.ihg.com.cn` 建立真实浏览器会话。
2. 在页面上下文中请求 `locations/v1/destinations`，把酒店/城市关键词转成经纬度。
3. 请求 `availability/v3/hotels/offers` 获取候选酒店价格。
4. 请求 `hotels/v3/profiles/{hotelCode}/details` 补酒店名称。
5. 按输入酒店名做匹配，返回最低价格、币种、税费口径和房价代码。

核心文件：

```text
src/modules/ihg/IhgApiClient.ts
src/modules/ihg/IhgProvider.ts
```

## 逐站调试 selector

先一次只调一个站点，避免三个浏览器流程的日志混在一起。

```bash
npm run debug:provider -- \
  --provider ihg \
  --hotel "上海静安寺智选假日酒店" \
  --checkIn 2026-07-01 \
  --checkOut 2026-07-02
```

provider 可选：

```text
ctrip | ihg | marriott | all
```

调试顺序：

1. 先跑 `marriott`，看命令行输出的 `status`、`sourceUrl`、`errorMessage`。
2. 如果失败，打开 `.artifacts/<provider>/` 里的截图，看页面停在哪一步。
3. 根据截图和浏览器 DevTools，修改对应的 `*.selectors.ts`。
4. 再跑同一个命令，直到能返回 `status: "success"` 或准确返回 `no_availability`。
5. 一个站点稳定后，再按同样方式调 `ihg` 和 `ctrip`。

优先检查这些 selector：

```text
destinationInput / hotelSearchInput  搜索框
searchButton                         搜索按钮
hotelCards                           酒店列表卡片
hotelName                            酒店名称
priceText                            价格文本
```
