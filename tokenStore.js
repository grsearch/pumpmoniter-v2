/**
 * In-memory token store — 两阶段版
 *
 * Phase 1（pending）：收录后等待 5 分钟，做第一次 FDV/LP 检测
 * Phase 2（watch）  ：通过后持续监控，每 5 分钟刷新数据
 *   - FDV < 15K 或 LP < 5K → 随时退出
 *   - 满 6 小时且 FDV > 5万 LP > 1万 → 发 webhook（只发一次）
 *   - 满 12 小时 → 强制退出
 */

const FIRST_CHECK_MS  = 5  * 60 * 1000;   // 5 分钟：第一次检测
const WATCH_MIN_MS    = 6  * 60 * 60 * 1000;  // 6 小时：最早可发 webhook
const MAX_WATCH_MS    = 12 * 60 * 60 * 1000;  // 12 小时：强制退出

const PHASE_PENDING = 'pending';
const PHASE_WATCH   = 'watch';
const PHASE_DONE    = 'done';

class TokenStore {
  constructor() {
    this.tokens = new Map();
  }

  add(token) {
    this.tokens.set(token.mint, {
      ...token,
      addedAt:        token.addedAt || Date.now(),
      phase:          PHASE_PENDING,
      firstCheckAt:   null,
      webhookFiredAt: null,
      xMentions:      null,
      xMentionsDelta: null,
      lastXCheckAt:   null,
    });
  }

  get(mint) {
    const t = this.tokens.get(mint);
    return t ? this._toPublic(t) : null;
  }

  _getRaw(mint) {
    return this.tokens.get(mint) || null;
  }

  update(mint, fields) {
    const existing = this.tokens.get(mint);
    if (!existing) return;
    this.tokens.set(mint, {
      ...existing,
      ...fields,
      updatedAt: Date.now(),
    });
  }

  remove(mint) {
    this.tokens.delete(mint);
  }

  getAll() {
    return Array.from(this.tokens.values())
      .map(t => this._toPublic(t))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  _toPublic(t) {
    return { ...t };
  }

  size() {
    return this.tokens.size;
  }
}

module.exports = {
  TokenStore,
  FIRST_CHECK_MS,
  WATCH_MIN_MS,
  MAX_WATCH_MS,
  PHASE_PENDING,
  PHASE_WATCH,
  PHASE_DONE,
};
