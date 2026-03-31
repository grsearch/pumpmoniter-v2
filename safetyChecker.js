const axios = require('axios');

/**
 * 统一安全检测模块（前置过滤器）
 *
 * 两关检测，全部通过才允许入库追踪：
 *   1. Authority Check  — Birdeye 检查 mint/freeze authority
 *   2. Bundle Detection — top holders 是否与 dev 关联（bundling）
 */

const BUNDLE_HIGH_THRESHOLD = Number(process.env.BUNDLE_HIGH_THRESHOLD) || 5;
const BUNDLE_MED_THRESHOLD  = Number(process.env.BUNDLE_MED_THRESHOLD)  || 3;
const FUNDING_TX_LIMIT = 10;

class SafetyChecker {
  constructor(heliusRpcUrl, birdeyeService) {
    this.rpcUrl  = heliusRpcUrl;
    this.birdeye = birdeyeService;
  }

  /**
   * 主入口：依次执行两关检测
   * @returns {{ safe, stage, risk, bundleRisk, bundleDetails }}
   */
  async check(mintAddress, devAddress) {
    const result = {
      safe: false,
      stage: '',
      risk: 'unknown',
      bundleRisk: 'unknown',
      bundleDetails: null,
    };

    // ========== 第一关：Authority Check ==========
    try {
      const authOk = await this.birdeye.checkAuthorities(mintAddress);
      if (!authOk) {
        result.stage = 'authority';
        result.risk = 'high';
        console.log(`[Safety] ✗ ${mintAddress.slice(0, 8)}... FAILED authority check`);
        return result;
      }
      console.log(`[Safety] ✓ ${mintAddress.slice(0, 8)}... authority OK`);
    } catch (err) {
      console.error(`[Safety] authority check error: ${err.message}`);
    }

    // ========== 第二关：Bundle Detection ==========
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
    result.risk = bundleResult.risk;

    console.log(`[Safety] ✅ ${mintAddress.slice(0, 8)}... ALL PASSED | bundle=${bundleResult.risk}`);

    return result;
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

      const holdersToCheck = topHolders
        .filter(h => h.owner !== devAddress)
        .slice(0, 10);

      if (holdersToCheck.length === 0) {
        return { bundled: false, risk: 'low', details: { reason: 'no non-dev holders' } };
      }

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

      let devLinkedCount = 0;
      if (devAddress) {
        for (const [, sources] of fundingSources) {
          if (sources.has(devAddress)) devLinkedCount++;
        }
      }

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
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { SafetyChecker };
