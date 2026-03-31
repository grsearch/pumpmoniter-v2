const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发条件（AND 关系，全部满足才发送）：
 *   - FDV >= $25,000
 *   - LP  >= $5,000
 *   - HOLDERS >= 10
 *
 * firedSet 保证每个 mint 只发送一次。
 */

class WebhookService {
  constructor() {
    this.url        = process.env.WEBHOOK_URL || '';
    this.minFdv     = Number(process.env.WEBHOOK_MIN_FDV)      || 25000;
    this.minLp      = Number(process.env.WEBHOOK_MIN_LP)       || 5000;
    this.minHolders = Number(process.env.WEBHOOK_MIN_HOLDERS)  || 10;

    this.firedSet    = new Set();
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Thresholds: FDV≥$${this.minFdv} LP≥$${this.minLp} Holders≥${this.minHolders}`);
    }
  }

  setBroadcast(fn) {
    this.broadcastFn = fn;
  }

  get enabled() {
    return !!this.url;
  }

  async check(token, stable) {
    if (!this.enabled) return;
    if (this.firedSet.has(token.mint)) return;

    if ((token.fdv     || 0) < this.minFdv) return;
    if ((token.lp      || 0) < this.minLp) return;
    if ((token.holders || 0) < this.minHolders) return;

    this.firedSet.add(token.mint);
    await this._send(token);
  }

  async _send(token) {
    const fmt1 = (v) => v !== null && v !== undefined ? Number(v).toFixed(1) + '%' : null;

    const payload = {
      network:    'solana',
      address:    token.mint,
      symbol:     token.symbol,
      fdv:        token.fdv,
      lp:         token.lp,
      holders:    token.holders    ?? 0,
      top10Pct:   fmt1(token.top10Pct),
      devPct:     fmt1(token.devPct),
      bundleRisk: token.bundleRisk || 'unknown',
    };

    console.log(
      `[Webhook] 🚀 Firing $${token.symbol}` +
      ` | FDV=$${token.fdv} LP=$${token.lp}` +
      ` | Holders=${payload.holders}` +
      ` | Bundle=${token.bundleRisk}`
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
}

module.exports = { WebhookService };
