/**
 * In-memory token store — 两阶段定时检测版本
 *
 * 阶段 1（收录后 +5 分钟）：第一次检测 FDV/LP
 *   - FDV >= $15,000 且 LP >= $5,000 → 留存进入阶段 2
 *   - 不符合 → 退出
 *
 * 阶段 2（收录后 +12 小时）：第二次检测 FDV/LP
 *   - FDV > $50,000 且 LP > $10,000 → 发送 webhook
 *   - 无论是否符合，退出监控
 *
 * 12小时内不做任何实时 FDV/LP API 查询，节省配额。
 */

// 第一次检测：收录后 5 分钟
const FIRST_CHECK_MS  = 5 * 60 * 1000;
// 第二次检测：收录后 12 小时
const SECOND_CHECK_MS = 12 * 60 * 60 * 1000;

// token 阶段
const PHASE_PENDING = 'pending';   // 等待第一次检测
const PHASE_WATCH   = 'watch';     // 通过第一次，等待第二次
const PHASE_DONE    = 'done';      // 已完成（即将退出）

class TokenStore {
  constructor() {
    this.tokens = new Map();
  }

  add(token) {
    this.tokens.set(token.mint, {
      ...token,
      addedAt:       token.addedAt || Date.now(),
      phase:         PHASE_PENDING,
      firstCheckAt:  null,
      secondCheckAt: null,
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

  msUntilFirstCheck(mint) {
    const t = this.tokens.get(mint);
    if (!t) return null;
    return (t.addedAt + FIRST_CHECK_MS) - Date.now();
  }

  msUntilSecondCheck(mint) {
    const t = this.tokens.get(mint);
    if (!t) return null;
    return (t.addedAt + SECOND_CHECK_MS) - Date.now();
  }
}

module.exports = { TokenStore, FIRST_CHECK_MS, SECOND_CHECK_MS, PHASE_PENDING, PHASE_WATCH, PHASE_DONE };
