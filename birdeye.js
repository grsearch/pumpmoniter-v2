const axios = require('axios');

/**
 * Birdeye API Service
 * 
 * 提供两个核心功能：
 *   1. checkAuthorities(mint) — 检查 mint/freeze authority 是否已 revoked
 *   2. getTokenData(mint)     — 获取代币基本数据（price, fdv, lp, holders 等）
 */

class BirdeyeService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://public-api.birdeye.so';
  }

  /**
   * 检查代币的 mint authority 和 freeze authority 是否已注销
   * @param {string} mintAddress
   * @returns {boolean} true = 安全（authority 已 revoked）
   */
  async checkAuthorities(mintAddress) {
    if (!this.apiKey) return true; // 没有 API key 跳过检查

    try {
      const res = await axios.get(`${this.baseUrl}/defi/token_security`, {
        headers: {
          'X-API-KEY': this.apiKey,
          'x-chain': 'solana',
        },
        params: { address: mintAddress },
        timeout: 10000,
      });

      const data = res.data?.data;
      if (!data) return true; // 无数据默认放行

      // mutableMetadata, freezeAuthority, mintAuthority 都应该为 null 或 false
      const mintAuth   = data.mintAuthority;
      const freezeAuth = data.freezeAuthority;

      if (mintAuth && mintAuth !== 'null' && mintAuth !== '') {
        console.log(`[Birdeye] ${mintAddress.slice(0,8)}... mintAuthority still set: ${mintAuth}`);
        return false;
      }

      if (freezeAuth && freezeAuth !== 'null' && freezeAuth !== '') {
        console.log(`[Birdeye] ${mintAddress.slice(0,8)}... freezeAuthority still set: ${freezeAuth}`);
        return false;
      }

      return true;
    } catch (err) {
      console.error(`[Birdeye] checkAuthorities error:`, err.message);
      return true; // API 出错默认放行
    }
  }

  /**
   * 获取代币基本数据
   * @param {string} mintAddress
   * @returns {object|null}
   */
  async getTokenData(mintAddress) {
    if (!this.apiKey) return null;

    try {
      const res = await axios.get(`${this.baseUrl}/defi/token_overview`, {
        headers: {
          'X-API-KEY': this.apiKey,
          'x-chain': 'solana',
        },
        params: { address: mintAddress },
        timeout: 10000,
      });

      const data = res.data?.data;
      if (!data) return null;

      return {
        symbol:         data.symbol || null,
        name:           data.name || null,
        logoURI:        data.logoURI || null,
        price:          data.price || 0,
        priceChange24h: data.priceChange24hPercent || 0,
        fdv:            data.mc || data.fdv || 0,
        liquidity:      data.liquidity || 0,
        holder:         data.holder || 0,
      };
    } catch (err) {
      console.error(`[Birdeye] getTokenData error:`, err.message);
      return null;
    }
  }
}

module.exports = { BirdeyeService };
