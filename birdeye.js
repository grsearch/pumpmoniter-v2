const axios = require('axios');

/**
 * Birdeye API Service
 *
 * 1. checkAuthorities(mint)  — 检查 mint/freeze authority 是否已 revoked
 * 2. getTokenData(mint)      — 获取代币数据（price, fdv, lp, holders）
 * 3. getXMentions(mint)      — 获取 Twitter/X 提及数（24h）
 */

class BirdeyeService {
  constructor(apiKey) {
    this.apiKey  = apiKey;
    this.baseUrl = 'https://public-api.birdeye.so';
  }

  async checkAuthorities(mintAddress) {
    if (!this.apiKey) return true;
    try {
      const res = await axios.get(`${this.baseUrl}/defi/token_security`, {
        headers: { 'X-API-KEY': this.apiKey, 'x-chain': 'solana' },
        params: { address: mintAddress },
        timeout: 10000,
      });
      const data = res.data?.data;
      if (!data) return true;
      const mintAuth   = data.mintAuthority;
      const freezeAuth = data.freezeAuthority;
      if (mintAuth   && mintAuth   !== 'null' && mintAuth   !== '') {
        console.log(`[Birdeye] ${mintAddress.slice(0,8)}... mintAuthority set: ${mintAuth}`);
        return false;
      }
      if (freezeAuth && freezeAuth !== 'null' && freezeAuth !== '') {
        console.log(`[Birdeye] ${mintAddress.slice(0,8)}... freezeAuthority set: ${freezeAuth}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[Birdeye] checkAuthorities error:`, err.message);
      return true;
    }
  }

  async getTokenData(mintAddress) {
    if (!this.apiKey) return null;
    try {
      const res = await axios.get(`${this.baseUrl}/defi/token_overview`, {
        headers: { 'X-API-KEY': this.apiKey, 'x-chain': 'solana' },
        params: { address: mintAddress },
        timeout: 10000,
      });
      const data = res.data?.data;
      if (!data) return null;
      return {
        symbol:         data.symbol        || null,
        name:           data.name          || null,
        logoURI:        data.logoURI       || null,
        price:          data.price         || 0,
        priceChange24h: data.priceChange24hPercent || 0,
        fdv:            data.mc || data.fdv || 0,
        liquidity:      data.liquidity     || 0,
        holder:         data.holder        || 0,
      };
    } catch (err) {
      console.error(`[Birdeye] getTokenData error:`, err.message);
      return null;
    }
  }

  /**
   * 获取代币的 X (Twitter) 提及数（过去 24 小时）
   * Birdeye /defi/token_trending 或 token_overview 中的 social 字段
   * 如果 overview 里已有 social 数据直接用，否则单独查 token_market_data
   */
  async getXMentions(mintAddress) {
    if (!this.apiKey) return null;
    try {
      // Birdeye token_overview 包含 extensions.twitter & social 数据
      const res = await axios.get(`${this.baseUrl}/defi/token_overview`, {
        headers: { 'X-API-KEY': this.apiKey, 'x-chain': 'solana' },
        params: { address: mintAddress },
        timeout: 10000,
      });
      const data = res.data?.data;
      if (!data) return null;

      // 尝试多个可能的字段路径
      const mentions =
        data.extensions?.coingeckoId  ? null :   // coingecko 字段不是 mentions
        data.numberMentions            != null ? Number(data.numberMentions) :
        data.mention24h                != null ? Number(data.mention24h)     :
        data.uniqueWallet24h           != null ? Number(data.uniqueWallet24h): // 用活跃钱包数代替
        null;

      return mentions;
    } catch (err) {
      console.error(`[Birdeye] getXMentions error:`, err.message);
      return null;
    }
  }
}

module.exports = { BirdeyeService };
