const axios = require('axios');

/**
 * Webhook 发送服务 — 两阶段版
 *
 * 第二次检测触发条件（AND 关系）：
 *   - FDV > $50,000
 *   - LP  > $10,000
 */

class WebhookService {
  constructor() {
    this.url    = process.env.WEBHOOK_URL || '';

    // 第一次检测留存阈值
    this.phase1MinFdv = Number(process.env.PHASE1_MIN_FDV) || 15000;
    this.phase1MinLp  = Number(process.env.PHASE1_MIN_LP)  || 5000;

    // 第二次检测 webhook 触发阈值
    this.phase2MinFdv = Number(process.env.PHASE2_MIN_FDV) || 50000;
    this.phase2MinLp  = Number(process.env.PHASE2_MIN_LP)  || 10000;

    this.firedSet    = new Set();
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Phase1 keep: FDV≥$${this.phase1MinFdv} LP≥$${this.phase1MinLp}`);
      console.log(`[Webhook] Phase2 fire: FDV>$${this.phase2MinFdv} LP>$${this.phase2MinLp}`);
    }
  }

  setBroadcast(fn) {
    this.broadcastFn = fn;
  }

  get enabled() {
    return !!this.url;
  }

  /** 第二次检测时调用，满足条件才发送 */
  async checkAndFire(token) {
    if (!this.enabled) return false;
    if (this.firedSet.has(token.mint)) return false;

    if ((token.fdv || 0) <= this.phase2MinFdv) return false;
    if ((token.lp  || 0) <= this.phase2MinLp)  return false;

    this.firedSet.add(token.mint);
    await this._send(token);
    return true;
  }

  async _send(token) {
    const fmt1 = (v) => v !== null && v !== undefined ? Number(v).toFixed(1) + '%' : null;

    const payload = {
      network:  'solana',
      address:  token.mint,
      symbol:   token.symbol,
      name:     token.name,
      fdv:      token.fdv,
      lp:       token.lp,
      holders:  token.holders ?? 0,
      top10Pct: fmt1(token.top10Pct),
      devPct:   fmt1(token.devPct),
      logoURI:  token.logoURI || '',
      addedAt:  token.addedAt,
    };

    console.log(
      `[Webhook] 🚀 Firing $${token.symbol}` +
      ` | FDV=$${token.fdv} LP=$${token.lp}` +
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

  getFired() {
    return Array.from(this.firedSet);
  }
}

module.exports = { WebhookService };
