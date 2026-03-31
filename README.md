# Pump Radar — Solana Migration Monitor

实时监控 pump.fun 代币迁移事件，通过安全检测过滤 rug pull，将合格代币推送到交易服务器。

## 架构

```
pump.fun 迁移事件 (Helius WebSocket)
        │
        ▼
🛡️ 前置安全检测 (safetyChecker.js)
  ├─ 1. Authority Check (Birdeye)
  └─ 2. Bundle Detection — 关联钱包检测
        │
        ▼ 通过
  入库追踪 (tokenStore.js)
  ├─ 实时刷新 LP/FDV/Holders (Birdeye, 每30s)
  └─ Holder stats 刷新 (Helius RPC, 每90s)
        │
        ▼ 全部条件满足
🔔 Webhook → 交易服务器
  条件: FDV≥$25K & LP≥$5K & Holders≥10
```

## 文件说明

| 文件 | 说明 |
|---|---|
| `index.js` | 主入口，Express + WebSocket + 调度器 |
| `safetyChecker.js` | 前置安全检测（authority + bundle） |
| `helius.js` | Helius WebSocket 监听 + RPC 轮询 |
| `birdeye.js` | Birdeye API（authority check + token data） |
| `webhook.js` | Webhook 发送服务 |
| `tokenStore.js` | 内存 token 存储 |
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
  "network": "solana",
  "address": "mint地址",
  "symbol": "TOKEN",
  "fdv": 50000,
  "lp": 8000,
  "holders": 120,
  "top10Pct": "35.2%",
  "devPct": "2.1%",
  "bundleRisk": "low"
}
```
