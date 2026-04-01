const axios = require('axios');

/**
 * 统一安全检测模块（前置过滤器）
 *
 * 三关检测，全部通过才允许入库追踪：
 *   1. Authority Check  — Birdeye 检查 mint/freeze authority
 *   2. Dev History Check — dev 钱包是否是 serial rugger
 *   3. Bundle Detection  — top holders 是否与 dev 关联（bundling）
 *
 * 调用方式：
 *   const result = await safetyChecker.check(mintAddress, devAddress);
 *   if (!result.safe) { // 拒绝 }
 */

const PUMP_BC_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// ========== 可配置阈值 ==========
const DEV_RISK_7D  = Number(process.env.DEV_RISK_7D_TOKENS)  || 3;
const DEV_RISK_30D = Number(process.env.DEV_RISK_30D_TOKENS) || 5;

const BUNDLE_HIGH_THRESHOLD = Number(process.env.BUNDLE_HIGH_THRESHOLD) || 5;
const BUNDLE_MED_THRESHOLD  = Number(process.env.BUNDLE_MED_THRESHOLD)  || 3;
const FUNDING_TX_LIMIT = 10;

class SafetyChecker {
  constructor(heliusRpcUrl, birdeyeService) {
    this.rpcUrl   = heliusRpcUrl;
    this.birdeye  = birdeyeService;

    // Dev 检查缓存（同一 dev 地址 30 分钟内不重复查）
    this.devCache = new Map();
    this.DEV_CACHE_TTL = 30 * 60 * 1000;
  }

  /**
   * 主入口：依次执行三关检测
   * @returns {{ safe, stage, risk, details }}
   *   safe   = true/false
   *   stage  = 'authority' | 'devHistory' | 'bundle' | 'passed'
   *   risk   = 'high' | 'medium' | 'low' | 'unknown'
   *   details = { ... }  各阶段详细信息
   */
  async check(mintAddress, devAddress) {
    const result = {
      safe: false,
      stage: '',
      risk: 'unknown',
      devRisk: 'unknown',
      devDetails: null,
      bundleRisk: 'unknown',
      bundleDetails: null,
    };

    // ========== 第一关：Authority Check ==========
    try {
      const authOk = await this.birdeye.checkAuthorities(mintAddress);
      if (!authOk) {
        result.stage = 'authority';
        result.risk = 'high';
        result.devDetails = { reason: 'Mint/Freeze authority not revoked' };
        console.log(`[Safety] ✗ ${mintAddress.slice(0, 8)}... FAILED authority check`);
        return result;
      }
      console.log(`[Safety] ✓ ${mintAddress.slice(0, 8)}... authority OK`);
    } catch (err) {
      console.error(`[Safety] authority check error: ${err.message}`);
      // 出错放行，不因 API 故障阻塞
    }

    // ========== 第二关：Dev History Check ==========
    const devResult = await this._checkDevHistory(devAddress, mintAddress);
    result.devRisk = devResult.risk;
    result.devDetails = devResult.details;

    if (!devResult.safe) {
      result.stage = 'devHistory';
      result.risk = devResult.risk;
      console.log(`[Safety] ✗ ${mintAddress.slice(0, 8)}... FAILED dev check: ${devResult.details.reason}`);
      return result;
    }
    console.log(`[Safety] ✓ ${mintAddress.slice(0, 8)}... dev history OK (${devResult.risk})`);

    // ========== 第三关：Bundle Detection ==========
    const bundleResult = await this._checkBundle(mintAddress, devAddress);
    result.bundleRisk = bundleResult.risk;
    result.bundleDetails = bundleResult.details;

    if (bundleResult.bundled && bundleResult.risk === 'high') {
      result.stage = 'bundle';
      result.risk = 'high';
      console.log(`[Safety] ✗ ${mintAddress.slice(0, 8)}... FAILED bundle check: ${bundleResult.details.reason}`);
      return result;
    }
    console.log(`[Safety] ✓ ${mintAddress.slice(0, 8)}... bundle OK (${bundleResult.risk})`);

    // ========== 全部通过 ==========
    result.safe = true;
    result.stage = 'passed';
    result.risk = this._overallRisk(devResult.risk, bundleResult.risk);

    console.log(
      `[Safety] ✅ ${mintAddress.slice(0, 8)}... ALL PASSED` +
      ` | dev=${devResult.risk} bundle=${bundleResult.risk} overall=${result.risk}`
    );

    return result;
  }

  /**
   * 综合风险等级：取 dev 和 bundle 中较高的
   */
  _overallRisk(devRisk, bundleRisk) {
    const levels = { high: 3, medium: 2, low: 1, unknown: 0 };
    const dv = levels[devRisk] || 0;
    const bv = levels[bundleRisk] || 0;
    const max = Math.max(dv, bv);
    if (max >= 3) return 'high';
    if (max >= 2) return 'medium';
    if (max >= 1) return 'low';
    return 'unknown';
  }

  // ================================================================
  //  DEV HISTORY CHECK
  // ================================================================

  async _checkDevHistory(devAddress, currentMint) {
    if (!devAddress) {
      return { safe: true, risk: 'unknown', details: { reason: 'no dev address' } };
    }

    // 缓存
    const cached = this.devCache.get(devAddress);
    if (cached && (Date.now() - cached.checkedAt) < this.DEV_CACHE_TTL) {
      console.log(`[Safety/Dev] cache hit: ${devAddress.slice(0, 8)}... → ${cached.risk}`);
      return { safe: cached.safe, risk: cached.risk, details: cached.details };
    }

    try {
      const pumpSigs = await this._getDevPumpSignatures(devAddress);

      const now = Date.now();
      const SEVEN_DAYS  = 7  * 24 * 3600 * 1000;
      const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

      let count7d = 0, count30d = 0, countAll = pumpSigs.length;

      for (const sig of pumpSigs) {
        const ts = (sig.blockTime || 0) * 1000;
        const age = now - ts;
        if (age <= SEVEN_DAYS)  count7d++;
        if (age <= THIRTY_DAYS) count30d++;
      }

      let safe = true;
      let risk = 'low';
      let reason = '';

      if (count7d >= DEV_RISK_7D) {
        safe = false;
        risk = 'high';
        reason = `${count7d} pump.fun txs in 7d (threshold: ${DEV_RISK_7D})`;
      } else if (count30d >= DEV_RISK_30D) {
        safe = false;
        risk = 'high';
        reason = `${count30d} pump.fun txs in 30d (threshold: ${DEV_RISK_30D})`;
      } else if (count7d >= 2) {
        risk = 'medium';
        reason = `${count7d} pump.fun txs in 7d`;
      }

      const details = {
        devAddress: devAddress.slice(0, 8) + '...',
        txCount7d: count7d,
        txCount30d: count30d,
        txCountAll: countAll,
        reason: reason || 'clean history',
      };

      // 缓存
      this.devCache.set(devAddress, { safe, risk, details, checkedAt: Date.now() });
      this._cleanCache();

      return { safe, risk, details };

    } catch (err) {
      console.error(`[Safety/Dev] error: ${err.message}`);
      return { safe: true, risk: 'unknown', details: { reason: `check failed: ${err.message}` } };
    }
  }

  async _getDevPumpSignatures(devAddress) {
    const allSigs = await this._fetchSignatures(devAddress, 100);
    const sigsToCheck = allSigs.slice(0, 50);
    const pumpSigs = [];

    for (let i = 0; i < sigsToCheck.length; i += 5) {
      const batch = sigsToCheck.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(sig => this._checkIfPumpTx(sig.signature))
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value) {
          pumpSigs.push(batch[j]);
        }
      }
      if (i + 5 < sigsToCheck.length) await sleep(200);
    }

    return pumpSigs;
  }

  async _checkIfPumpTx(signature) {
    try {
      const res = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0', id: 1,
        method: 'getTransaction',
        params: [signature, {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        }],
      }, { timeout: 12000 });

      const tx = res.data?.result;
      if (!tx) return false;

      const keys = tx.transaction?.message?.accountKeys || [];
      for (const acc of keys) {
        if ((acc.pubkey || acc) === PUMP_BC_PROGRAM) return true;
      }
      const logs = tx.meta?.logMessages || [];
      return logs.some(log => log.includes(PUMP_BC_PROGRAM));
    } catch (err) {
      return false;
    }
  }

  // ================================================================
  //  BUNDLE DETECTION
  // ================================================================

  async _checkBundle(mintAddress, devAddress) {
    try {
      const topHolders = await this._getTopHolders(mintAddress);
      if (topHolders.length === 0) {
        return { bundled: false, risk: 'unknown', details: { reason: 'no holders yet' } };
      }

      // 排除 dev 自身
      const holdersToCheck = topHolders
        .filter(h => h.owner !== devAddress)
        .slice(0, 10);

      if (holdersToCheck.length === 0) {
        return { bundled: false, risk: 'low', details: { reason: 'no non-dev holders' } };
      }

      // 查每个 holder 的 SOL 资金来源
      const fundingSources = new Map();
      const allFunders = new Map();

      for (const holder of holdersToCheck) {
        const sources = await this._getFundingSources(holder.owner);
        fundingSources.set(holder.owner, sources);
        for (const funder of sources) {
          allFunders.set(funder, (allFunders.get(funder) || 0) + 1);
        }
        await sleep(300);
      }

      // 与 dev 直接关联
      let devLinkedCount = 0;
      if (devAddress) {
        for (const [, sources] of fundingSources) {
          if (sources.has(devAddress)) devLinkedCount++;
        }
      }

      // 共享同一来源的最大聚类
      let maxSharedCount = 0;
      let maxSharedFunder = null;
      for (const [funder, count] of allFunders) {
        if (this._isKnownExchange(funder)) continue;
        if (count > maxSharedCount) {
          maxSharedCount = count;
          maxSharedFunder = funder;
        }
      }

      let bundled = false;
      let risk = 'low';
      let reason = '';

      if (devLinkedCount >= BUNDLE_HIGH_THRESHOLD) {
        bundled = true;
        risk = 'high';
        reason = `${devLinkedCount}/${holdersToCheck.length} top holders funded by dev`;
      } else if (maxSharedCount >= BUNDLE_HIGH_THRESHOLD) {
        bundled = true;
        risk = 'high';
        reason = `${maxSharedCount}/${holdersToCheck.length} share funder ${maxSharedFunder?.slice(0, 8)}...`;
      } else if (devLinkedCount >= BUNDLE_MED_THRESHOLD || maxSharedCount >= BUNDLE_MED_THRESHOLD) {
        bundled = true;
        risk = 'medium';
        reason = `devLinked=${devLinkedCount}, maxShared=${maxSharedCount}`;
      }

      const details = {
        holdersChecked: holdersToCheck.length,
        devLinkedCount,
        maxSharedCount,
        maxSharedFunder: maxSharedFunder ? maxSharedFunder.slice(0, 8) + '...' : null,
        reason: reason || 'no bundling detected',
      };

      return { bundled, risk, details };

    } catch (err) {
      console.error(`[Safety/Bundle] error: ${err.message}`);
      return { bundled: false, risk: 'unknown', details: { reason: `error: ${err.message}` } };
    }
  }

  async _getTopHolders(mintAddress) {
    try {
      const res = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccounts',
        params: { mint: mintAddress, limit: 20, page: 1 },
      }, { timeout: 15000 });

      const accounts = res.data?.result?.token_accounts || [];
      return accounts
        .map(a => ({ owner: a.owner, amount: Number(a.amount || 0) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);
    } catch (err) {
      console.error(`[Safety/Bundle] getTopHolders error:`, err.message);
      return [];
    }
  }

  async _getFundingSources(address) {
    const sources = new Set();
    try {
      const res = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: FUNDING_TX_LIMIT, commitment: 'confirmed' }],
      }, { timeout: 12000 });

      const sigs = res.data?.result || [];

      for (const sig of sigs.slice(0, 8)) {
        try {
          const txRes = await axios.post(this.rpcUrl, {
            jsonrpc: '2.0', id: 1,
            method: 'getTransaction',
            params: [sig.signature, {
              encoding: 'jsonParsed',
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            }],
          }, { timeout: 12000 });

          const tx = txRes.data?.result;
          if (!tx) continue;

          const instructions = tx.transaction?.message?.instructions || [];
          const innerInstructions = tx.meta?.innerInstructions || [];

          for (const ix of instructions) {
            if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
              const info = ix.parsed.info;
              if (info.destination === address && info.source !== address) {
                sources.add(info.source);
              }
            }
          }

          for (const inner of innerInstructions) {
            for (const ix of inner.instructions || []) {
              if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
                const info = ix.parsed.info;
                if (info.destination === address && info.source !== address) {
                  sources.add(info.source);
                }
              }
            }
          }
        } catch (e) { /* skip */ }
        await sleep(150);
      }
    } catch (err) {
      console.error(`[Safety/Bundle] getFundingSources error:`, err.message);
    }
    return sources;
  }

  _isKnownExchange(address) {
    const KNOWN = new Set([
      '11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
      '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
      '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
    ]);
    return KNOWN.has(address);
  }

  // ================================================================
  //  UTILS
  // ================================================================

  async _fetchSignatures(address, limit) {
    const res = await axios.post(this.rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [address, { limit, commitment: 'confirmed' }],
    }, { timeout: 15000 });
    return res.data?.result || [];
  }

  _cleanCache() {
    if (this.devCache.size > 500) {
      const cutoff = Date.now() - this.DEV_CACHE_TTL;
      for (const [key, val] of this.devCache) {
        if (val.checkedAt < cutoff) this.devCache.delete(key);
      }
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { SafetyChecker };
