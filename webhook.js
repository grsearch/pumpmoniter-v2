const axios = require('axios');

/**
 * Webhook 发送服务
 *
 * 触发时机：Phase 2 运行满 6 小时后，每次刷新时检查
 *   FDV > $50,000 且 LP > $10,000 → 发送（每个 mint 只发一次）
 */

class WebhookService {
  constructor() {
    this.url = process.env.WEBHOOK_URL || '';

    // Phase 1 留存阈值
    this.phase1MinFdv = Number(process.env.PHASE1_MIN_FDV) || 15000;
    this.phase1MinLp  = Number(process.env.PHASE1_MIN_LP)  || 5000;

    // Phase 2 watch 期间退出阈值（低于此值随时退出）
    this.watchMinFdv  = Number(process.env.WATCH_MIN_FDV)  || 15000;
    this.watchMinLp   = Number(process.env.WATCH_MIN_LP)   || 5000;

    // Phase 2 webhook 触发阈值（满 6h 后检查）
    this.fireMinFdv   = Number(process.env.FIRE_MIN_FDV)   || 50000;
    this.fireMinLp    = Number(process.env.FIRE_MIN_LP)    || 10000;

    this.firedSet    = new Set();
    this.broadcastFn = null;

    if (!this.url) {
      console.warn('[Webhook] WEBHOOK_URL not set — webhook disabled');
    } else {
      console.log(`[Webhook] Enabled → ${this.url}`);
      console.log(`[Webhook] Phase1 keep : FDV≥$${this.phase1MinFdv} LP≥$${this.phase1MinLp}`);
      console.log(`[Webhook] Watch exit  : FDV<$${this.watchMinFdv} or LP<$${this.watchMinLp}`);
      console.log(`[Webhook] Fire (≥6h)  : FDV>$${this.fireMinFdv} LP>$${this.fireMinLp}`);
    }
  }

  setBroadcast(fn) { this.broadcastFn = fn; }

  get enabled() { return !!this.url; }

  /**
   * 在 watch 期间每次刷新后调用
   * @param {object} token   store 里的 token 对象
   * @param {number} ageMs   token 年龄（毫秒）
   * @returns {boolean} 是否发送了 webhook
   */
  async checkAndFire(token, ageMs) {
    if (!this.enabled)              return false;
    if (this.firedSet.has(token.mint)) return false;

    // 未满 6 小时不触发
    const WATCH_MIN_MS = 6 * 60 * 60 * 1000;
    if (ageMs < WATCH_MIN_MS)       return false;

    if ((token.fdv || 0) <= this.fireMinFdv) return false;
    if ((token.lp  || 0) <= this.fireMinLp)  return false;

    this.firedSet.add(token.mint);
    await this._send(token);
    return true;
  }

  async _send(token) {
    const payload = {
      network:    'solana',
      source:     token.source || 'unknown',
      address:    token.mint,
      symbol:     token.symbol,
      name:       token.name,
      logoURI:    token.logoURI || '',
      fdv:        token.fdv,
      lp:         token.lp,
      holders:    token.holders  ?? 0,
      price:      token.price    ?? 0,
      xMentions:  token.xMentions ?? null,
      addedAt:    token.addedAt,
      ageHours:   Math.round((Date.now() - token.addedAt) / 3600000 * 10) / 10,
    };

    console.log(
      `[Webhook] 🚀 Firing $${token.symbol} [${token.source}]` +
      ` | FDV=$${fmtNum(token.fdv)} LP=$${fmtNum(token.lp)}` +
      ` | Holders=${payload.holders} X=${payload.xMentions ?? 'n/a'}`
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
