# Pump Radar — Solana Migration Monitor

实时监控 **pump.fun** 代币迁移事件，迁移那一刻做安全检测和数据校验，
满足阈值即推送 webhook 到交易服务器。

## 架构

```
pump.fun 迁移事件 (Helius WebSocket)
        │
        ▼
🛡️ Authority Check (Birdeye)
        │
        ▼ 通过
📊 拉取 Birdeye 数据 (FDV / LP / holders)
        │
        ▼ 满足条件
🔔 Webhook → 交易服务器
  条件: FDV ≥ $20K  且  LP ≥ $5K
```

> 不再做 Phase 1 / Phase 2 阶段分级、不再监控 LetsBonk。
> 迁移那一刻一次性判断即可。

## 文件说明

| 文件 | 说明 |
|---|---|
| `index.js` | 主入口，Express + WebSocket + 迁移事件处理 |
| `safetyChecker.js` | Authority Check |
| `helius.js` | Helius WebSocket 监听 + 轮询（仅 pump.fun） |
| `birdeye.js` | Birdeye API |
| `webhook.js` | Webhook 发送服务 |
| `tokenStore.js` | 内存 token 存储（仅供前端展示） |
| `proxy.js` | Webshare 代理管理 |
| `public/index.html` | 前端 Dashboard |

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env 填入 API keys
npm start
```

## Webhook Payload

```json
{
  "network":  "solana",
  "source":   "pump.fun",
  "address":  "mint地址",
  "symbol":   "TOKEN",
  "name":     "Token Name",
  "logoURI":  "...",
  "fdv":      25000,
  "lp":       6000,
  "holders":  120,
  "price":    0.000123,
  "addedAt":  1731890000000
}
```

## 触发阈值（可在 .env 中调整）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FIRE_MIN_FDV` | 20000 | FDV ≥ 此值才发 webhook |
| `FIRE_MIN_LP`  | 5000  | LP  ≥ 此值才发 webhook |
| `FETCH_MAX_TRIES` | 4 | 迁移那一刻 Birdeye 重试次数 |
| `FETCH_RETRY_MS`  | 2000 | 每次重试间隔（ms） |

## 工作时间

北京时间 07:00 – 23:30 自动开/停监控。
