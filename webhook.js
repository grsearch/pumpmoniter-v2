const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发时机：迁移那一刻，FDV ≥ $20,000 且 LP ≥ $5,000 → 立即发送
 * 每个 mint 只发一次。
 */

class WebhookService {
  constructor() {
    this.url = process.env.WEBHOOK_URL || '';

    // Webhook 触发阈值（迁移那一刻）
    this.fireMinFdv = Number(process.env.FIRE_MIN_FDV) || 20000;
    this.fireMinLp  = Number(process.env.FIRE_MIN_LP)  || 5000;

    this.firedSet    = new Set();
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Fire condition: FDV≥$${this.fireMinFdv} & LP≥$${this.fireMinLp}`);
    }
  }

  setBroadcast(fn) { this.broadcastFn = fn; }

  get enabled() { return !!this.url; }

  /**
   * 迁移那一刻判断并发送
   * @param {object} token token 对象（含 mint/symbol/fdv/lp 等）
   * @returns {boolean} 是否发送了 webhook
   */
  async checkAndFire(token) {
    if (!this.enabled)                  return false;
    if (this.firedSet.has(token.mint))  return false;

    const fdv = Number(token.fdv) || 0;
    const lp  = Number(token.lp)  || 0;

    if (fdv < this.fireMinFdv) return false;
    if (lp  < this.fireMinLp)  return false;

    this.firedSet.add(token.mint);
    await this._send(token);
    return true;
  }

  async _send(token) {
    const payload = {
      network:  'solana',
      source:   token.source || 'pump.fun',
      address:  token.mint,
      symbol:   token.symbol,
      name:     token.name,
      logoURI:  token.logoURI || '',
      fdv:      token.fdv,
      lp:       token.lp,
      holders:  token.holders ?? 0,
      price:    token.price   ?? 0,
      addedAt:  token.addedAt,
    };

    console.log(
      `[Webhook] 🚀 Firing $${token.symbol} [${payload.source}]` +
      ` | FDV=$${fmtNum(token.fdv)} LP=$${fmtNum(token.lp)}` +
      ` | Holders=${payload.holders}`
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

  getFired() { return Array.from(this.firedSet); }
}

function fmtNum(n) {
  const v = Number(n);
  if (!v || isNaN(v)) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

module.exports = { WebhookService };
