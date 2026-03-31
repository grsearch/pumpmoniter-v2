# Pump Radar V2 — Solana Migration Monitor

实时监控 pump.fun 代币迁移事件，通过多层安全检测过滤 rug pull，将合格代币推送到交易服务器。

## 架构

```
pump.fun 迁移事件 (Helius WebSocket)
        │
        ▼
🛡️ 前置安全检测 (safetyChecker.js)
  ├─ 1. Authority Check (Birdeye)
  ├─ 2. Dev History — serial rugger 检测
  └─ 3. Bundle Detection — 关联钱包检测
        │
        ▼ 通过
  入库追踪 (tokenStore.js)
  ├─ 实时刷新 LP/FDV/Holders (Birdeye, 每30s)
  ├─ Holder stats 刷新 (Helius RPC, 每90s)
  └─ X 社交分析 (xsocial.js, 异步)
        │
        ▼ 全部条件满足
🔔 Webhook → 交易服务器
  条件: FDV≥$25K & LP≥$5K & Holders≥10 & XScore≥10
```

## 文件说明

| 文件 | 说明 |
|---|---|
| `index.js` | 主入口，Express 服务 + WebSocket + 调度器 |
| `safetyChecker.js` | 统一前置安全检测（authority + dev history + bundle） |
| `helius.js` | Helius WebSocket 监听 + RPC 轮询 |
| `birdeye.js` | Birdeye API（authority check + token data） |
| `xsocial.js` | X 社交质量分析（推文作者质量而非纯计数） |
| `webhook.js` | Webhook 发送服务（含 pending 机制） |
| `tokenStore.js` | 内存 token 存储（含 LP/FDV 稳定读数机制） |
| `proxy.js` | Webshare 代理管理（X API 访问） |
| `public/index.html` | 前端 Dashboard |

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API keys

# 启动
npm start
```

## 环境变量

参见 `.env.example`，核心配置：

- `HELIUS_API_KEY` — Helius RPC（必需）
- `BIRDEYE_API_KEY` — Birdeye API（必需）
- `X_BEARER_TOKEN` — X API Bearer Token（需支持 /2/tweets/search/recent）
- `WEBHOOK_URL` — 交易服务器 webhook 地址
- `WEBHOOK_MIN_X_SCORE` — X 社交评分最低门槛（默认 10）
- `DEV_RISK_7D_TOKENS` — Dev 7天内 pump.fun 交互阈值（默认 3）
- `BUNDLE_HIGH_THRESHOLD` — Bundle 检测高风险阈值（默认 5）

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
  "devRisk": "low",
  "bundleRisk": "low",
  "xScore": 42,
  "xRealUsers": 3,
  "xAvgFollowers": 1200,
  "xEngagement": 28
}
```

## Systemd 服务

```bash
# /etc/systemd/system/pumpmoniter.service
[Unit]
Description=Pump Monitor V2
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/project
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable pumpmoniter
sudo systemctl start pumpmoniter
```
