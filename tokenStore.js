/**
 * In-memory token store —— 简化版
 *
 * 不再有阶段切换。迁移那一刻：
 *   ① 安全检测通过 → 拉取 FDV/LP
 *   ② 满足 FDV≥$20K & LP≥$5K → 发 webhook
 *   ③ 记录入库供前端 Dashboard 展示
 */

const MAX_KEEP_MS = 12 * 60 * 60 * 1000; // 12 小时后从前端清理（仅用于内存清理）

class TokenStore {
  constructor() {
    this.tokens = new Map();
  }

  add(token) {
    this.tokens.set(token.mint, {
      ...token,
      addedAt: token.addedAt || Date.now(),
    });
  }

  get(mint) {
    const t = this.tokens.get(mint);
    return t ? { ...t } : null;
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
      .map(t => ({ ...t }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  size() {
    return this.tokens.size;
  }
}

module.exports = {
  TokenStore,
  MAX_KEEP_MS,
};
