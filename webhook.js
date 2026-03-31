const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发条件（AND 关系，全部满足才发送）：
 *   - FDV >= $25,000
 *   - LP  >= $5,000
 *   - HOLDERS >= 10
 *   - X Social Score >= 10（至少有真实用户提及）
 *
 * firedSet 保证每个 mint 只发送一次。
 * pendingSet 记录已满足链上条件但等待社交评分的代币。
 */

class WebhookService {
  constructor() {
    this.url       = process.env.WEBHOOK_URL || '';
    this.minFdv    = Number(process.env.WEBHOOK_MIN_FDV)       || 25000;
    this.minLp     = Number(process.env.WEBHOOK_MIN_LP)        || 5000;
    this.minHolders = Number(process.env.WEBHOOK_MIN_HOLDERS)  || 10;
    this.minXScore = Number(process.env.WEBHOOK_MIN_X_SCORE)   || 10;

    this.firedSet    = new Set();
    this.pendingSet  = new Set(); // 链上条件已满足，等社交评分
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Thresholds: FDV≥$${this.minFdv} LP≥$${this.minLp} Holders≥${this.minHolders} XScore≥${this.minXScore}`);
    }
  }

  setBroadcast(fn) {
    this.broadcastFn = fn;
  }

  get enabled() {
    return !!this.url;
  }

  /**
   * 检查是否触发 webhook
   * @param {object} token  完整 token 数据（含 xSocial）
   * @param {object|null} stable  稳定读数
   */
  async check(token, stable) {
    if (!this.enabled) return;
    if (this.firedSet.has(token.mint)) return;

    // 链上条件
    const chainOk =
      (token.fdv     || 0) >= this.minFdv &&
      (token.lp      || 0) >= this.minLp &&
      (token.holders || 0) >= this.minHolders;

    if (!chainOk) return;

    // 社交条件
    const xScore = token.xSocial?.score ?? null;

    if (xScore === null) {
      // 社交数据还没回来，标记为 pending
      if (!this.pendingSet.has(token.mint)) {
        this.pendingSet.add(token.mint);
        console.log(`[Webhook] ⏳ $${token.symbol} chain conditions met, waiting for X score...`);
      }
      return;
    }

    if (xScore < this.minXScore) {
      // 社交评分不达标
      if (this.pendingSet.has(token.mint)) {
        this.pendingSet.delete(token.mint);
        console.log(`[Webhook] ❌ $${token.symbol} X score ${xScore} < ${this.minXScore}, skipped`);
      }
      return;
    }

    // 全部条件满足，发送
    this.pendingSet.delete(token.mint);
    this.firedSet.add(token.mint);
    await this._send(token);
  }

  async _send(token) {
    const fmt1 = (v) => v !== null && v !== undefined ? Number(v).toFixed(1) + '%' : null;
    const xSocial = token.xSocial || {};

    const payload = {
      network:   'solana',
      address:   token.mint,
      symbol:    token.symbol,
      fdv:       token.fdv,
      lp:        token.lp,
      holders:   token.holders   ?? 0,
      top10Pct:  fmt1(token.top10Pct),
      devPct:    fmt1(token.devPct),
      devRisk:   token.devRisk   || 'unknown',
      bundleRisk: token.bundleRisk || 'unknown',
      xScore:       xSocial.score          ?? 0,
      xRealUsers:   xSocial.realUserCount  ?? 0,
      xAvgFollowers: xSocial.avgFollowers  ?? 0,
      xEngagement:  xSocial.totalEngagement ?? 0,
    };

    console.log(
      `[Webhook] 🚀 Firing $${token.symbol}` +
      ` | FDV=$${token.fdv} LP=$${token.lp}` +
      ` | Holders=${payload.holders}` +
      ` | XScore=${payload.xScore} Real=${payload.xRealUsers}` +
      ` | Dev=${token.devRisk} Bundle=${token.bundleRisk}`
    );

    try {
      const res = await axios.post(this.url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`[Webhook] ✅ $${token.symbol} → HTTP ${res.status}`);

      if (this.broadcastFn) {
        this.broadcastFn('webhook_fired', { mint: token.mint, symbol: token.symbol });
      }
    } catch (err) {
      this.firedSet.delete(token.mint);
      const status = err.response?.status;
      if (status) {
        console.error(`[Webhook] ❌ $${token.symbol} → HTTP ${status}:`, err.response?.data ?? '');
      } else {
        console.error(`[Webhook] ❌ $${token.symbol}:`, err.message);
      }
    }
  }

  getFired() {
    return Array.from(this.firedSet);
  }

  getPending() {
    return Array.from(this.pendingSet);
  }
}

module.exports = { WebhookService };
