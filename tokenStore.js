/**
 * In-memory token store
 *
 * 容错机制：
 * 每个 token 维护 lpFdvHistory 数组，记录最近 N 次 Birdeye 返回的
 * { lp, fdv, ts } 读数。退出判断和 webhook 触发都基于"稳定读数"：
 *   稳定读数 = 历史中存在两条间隔 >= STABLE_INTERVAL_MS 的记录
 * 这样单次 API 抖动（返回 0 或异常低值）不会误触发退出或 webhook。
 *
 * 注意：lpFdvHistory 不对外暴露（getAll/toPublic 会剔除），避免浪费带宽。
 */

const HISTORY_MAX = 5;
const STABLE_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

class TokenStore {
  constructor() {
    this.tokens = new Map();
  }

  add(token) {
    this.tokens.set(token.mint, {
      ...token,
      lpFdvHistory: [],
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
    const { lpFdvHistory: _ignored, ...safeFields } = fields;
    this.tokens.set(mint, {
      ...existing,
      ...safeFields,
      lpFdvHistory: existing.lpFdvHistory,
      updatedAt: Date.now(),
    });
  }

  recordLpFdv(mint, lp, fdv) {
    const token = this.tokens.get(mint);
    if (!token) return;

    const history = [...token.lpFdvHistory];
    history.push({ lp, fdv, ts: Date.now() });
    if (history.length > HISTORY_MAX) history.shift();

    this.tokens.set(mint, { ...token, lpFdvHistory: history });
  }

  getStableReading(mint) {
    const token = this.tokens.get(mint);
    if (!token) return null;

    const history = token.lpFdvHistory;
    if (history.length < 2) return null;

    const latest = history[history.length - 1];
    for (let i = history.length - 2; i >= 0; i--) {
      if (latest.ts - history[i].ts >= STABLE_INTERVAL_MS) {
        return { lp: latest.lp, fdv: latest.fdv, ts: latest.ts };
      }
    }
    return null;
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
    const { lpFdvHistory: _ignored, ...pub } = t;
    return pub;
  }

  size() {
    return this.tokens.size;
  }
}

module.exports = { TokenStore, STABLE_INTERVAL_MS };
