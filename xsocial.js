const axios = require('axios');
const { WebshareProxyManager } = require('./proxy');

/**
 * X (Twitter) 社交质量分析
 *
 * 改版说明：
 *   - 去掉了单纯的 mention count（实测无参考价值）
 *   - 改为搜索实际推文 → 分析推文作者的质量
 *   - 指标：
 *     · realUserCount:   真实用户数（followers >= 50, 账龄 >= 30 天）
 *     · avgFollowers:    提及该代币的用户平均 followers 数
 *     · totalEngagement: 所有推文的总互动数（likes + retweets + replies）
 *     · score:           综合社交评分（0-100）
 *
 * API 使用：
 *   - GET /2/tweets/search/recent（需要 Basic 或按量付费计划）
 *   - 每次搜索拉最多 10 条推文 + expansions=author_id + user.fields
 *   - 成本 ≈ $0.01/次（按量计费）
 */

const REAL_USER_MIN_FOLLOWERS = 50;
const REAL_USER_MIN_AGE_DAYS  = 30;
const MAX_TWEET_RESULTS       = 10;

class XSocialService {
  constructor(bearerToken) {
    this.bearerToken = bearerToken;
    this.baseUrl = 'https://api.twitter.com/2';
    this.proxy = new WebshareProxyManager();
  }

  /**
   * 分析代币的 X 社交质量
   * @param {string} symbol      代币符号
   * @param {string} mintAddress 合约地址
   * @returns {object|null}  { totalMentions, realUserCount, avgFollowers, totalEngagement, score, topTweet }
   */
  async analyze(symbol, mintAddress) {
    if (!this.bearerToken) {
      console.warn('[X] No bearer token, skipping social analysis');
      return null;
    }
    if (!mintAddress) return null;

    try {
      // 搜索包含合约地址的推文
      const tweets = await this._searchTweets(mintAddress);

      if (!tweets || tweets.data?.length === 0) {
        console.log(`[X] $${symbol} — no tweets found`);
        return {
          totalMentions: 0,
          realUserCount: 0,
          avgFollowers: 0,
          totalEngagement: 0,
          score: 0,
          topTweet: null,
        };
      }

      const tweetList = tweets.data || [];
      const users = new Map(); // userId -> user object
      (tweets.includes?.users || []).forEach(u => users.set(u.id, u));

      // 分析每条推文
      let realUserCount = 0;
      let totalFollowers = 0;
      let totalEngagement = 0;
      let topTweet = null;
      let topEngagement = -1;

      const now = new Date();

      for (const tweet of tweetList) {
        const user = users.get(tweet.author_id);
        if (!user) continue;

        const followers = user.public_metrics?.followers_count || 0;
        const createdAt = new Date(user.created_at);
        const ageDays = (now - createdAt) / (1000 * 86400);

        // 判断是否"真实用户"
        const isReal = followers >= REAL_USER_MIN_FOLLOWERS && ageDays >= REAL_USER_MIN_AGE_DAYS;
        if (isReal) realUserCount++;

        totalFollowers += followers;

        // 推文互动数
        const metrics = tweet.public_metrics || {};
        const engagement = (metrics.like_count || 0) +
                          (metrics.retweet_count || 0) +
                          (metrics.reply_count || 0) +
                          (metrics.quote_count || 0);
        totalEngagement += engagement;

        // 追踪最高互动推文
        if (engagement > topEngagement) {
          topEngagement = engagement;
          topTweet = {
            engagement,
            authorFollowers: followers,
            authorAge: Math.floor(ageDays),
            authorUsername: user.username,
            isReal,
          };
        }
      }

      const totalMentions = tweetList.length;
      const avgFollowers = totalMentions > 0
        ? Math.round(totalFollowers / totalMentions)
        : 0;

      // 综合评分（0-100）
      const score = this._calcScore(realUserCount, avgFollowers, totalEngagement, totalMentions);

      const result = {
        totalMentions,
        realUserCount,
        avgFollowers,
        totalEngagement,
        score,
        topTweet,
      };

      console.log(
        `[X] $${symbol} social: mentions=${totalMentions}` +
        ` real=${realUserCount} avgFollowers=${avgFollowers}` +
        ` engagement=${totalEngagement} score=${score}`
      );

      return result;

    } catch (err) {
      this._handleError(err, symbol);
      return null;
    }
  }

  /**
   * 搜索推文（含作者详情）
   */
  async _searchTweets(mintAddress) {
    const query = `"${mintAddress}" -is:retweet`;

    const end = new Date(Date.now() - 30 * 1000);
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

    const params = {
      query,
      max_results: MAX_TWEET_RESULTS,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      // 展开作者信息
      expansions: 'author_id',
      'tweet.fields': 'public_metrics,created_at',
      'user.fields': 'public_metrics,created_at,username,verified',
    };

    const proxyCfg = await this.proxy.getAxiosConfig();

    const res = await axios.get(`${this.baseUrl}/tweets/search/recent`, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
      params,
      timeout: 20000,
      ...(proxyCfg || {}),
    });

    return res.data;
  }

  /**
   * 综合社交评分
   * 权重：realUserCount(40%) + avgFollowers(30%) + engagement(30%)
   */
  _calcScore(realUserCount, avgFollowers, totalEngagement, totalMentions) {
    if (totalMentions === 0) return 0;

    // realUserCount 分数：0-40
    // 3+ real users = 满分
    const realScore = Math.min(realUserCount / 3, 1) * 40;

    // avgFollowers 分数：0-30
    // 5000+ avg followers = 满分
    const followerScore = Math.min(avgFollowers / 5000, 1) * 30;

    // engagement 分数：0-30
    // 50+ total engagement = 满分
    const engagementScore = Math.min(totalEngagement / 50, 1) * 30;

    return Math.round(realScore + followerScore + engagementScore);
  }

  _handleError(err, symbol) {
    const status = err.response?.status;
    if (status === 401) {
      console.error('[X] 401 Unauthorized — Bearer Token 无效或已过期');
    } else if (status === 403) {
      console.error('[X] 403 Forbidden — 你的 X 计划不支持 tweet search (需要 Basic+)');
    } else if (status === 429) {
      console.warn(`[X] 429 Rate Limited — ${symbol}`);
    } else if (status === 400) {
      console.error(`[X] 400 Bad Request — ${symbol}:`, err.response?.data ?? '');
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      console.error(`[X] 连接失败 (${err.code}) — 代理可能不可用`);
    } else {
      console.error(`[X] analyze(${symbol}) error:`, err.message);
    }
  }

  /**
   * 测试代理连通性
   */
  async testProxyConnection() {
    if (!this.proxy.enabled) {
      console.log('[X] No proxy configured, will connect direct');
      return { ok: false, error: 'not configured' };
    }
    console.log('[X] Testing proxy connection...');
    const result = await this.proxy.testProxy();
    if (result.ok) {
      console.log(`[X] Proxy OK — exit IP: ${result.ip}`);
    } else {
      console.warn(`[X] Proxy test failed: ${result.error}`);
    }
    return result;
  }
}

module.exports = { XSocialService };
