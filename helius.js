const WebSocket = require('ws');
const axios = require('axios');

/**
 * Helius Migration Monitor v2
 *
 * 修复漏检问题：
 *
 * 1. WebSocket 同时订阅两个 program:
 *    - PUMP_BC_PROGRAM  (6EF8r...) — Pump.fun Bonding Curve 主程序
 *    - PUMP_AMM_PROGRAM (pAMMBay...) — PumpSwap AMM 程序
 *    2025年3月后 95%+ 的迁移走 PumpSwap，旧版只订阅了 BC 程序
 *
 * 2. 轮询同时覆盖两个 program，间隔从 20s → 5s，签名数 25 → 100
 *
 * 3. 日志关键词扩展：增加 'Migrate'（PumpSwap 迁移的实际日志关键词）
 *
 * 4. Mint 提取放宽：不再要求 endsWith('pump')，fallback 到所有 SPL token
 *
 * 5. 错误交易也尝试提取（某些迁移有部分错误但实际已完成）
 */

const PUMP_BC_PROGRAM  = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// pump.fun 迁移钱包（所有迁移交易的 fee payer）
const MIGRATION_ACCOUNT = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';

const STANDARD_WS_URL = (apiKey) => `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const RPC_URL         = (apiKey) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const POLL_INTERVAL_MS = 5 * 1000;   // 5 秒轮询（旧版 20 秒太慢）
const SIGNATURES_LIMIT = 100;         // 每次拉 100 条（旧版 25 太少）
const PING_INTERVAL_MS = 30 * 1000;

class HeliusMonitor {
  constructor(apiKey) {
    this.apiKey    = apiKey;
    this.rpcUrl    = RPC_URL(apiKey);
    this.wsUrl     = STANDARD_WS_URL(apiKey);
    this.callbacks = [];
    this.ws        = null;
    this.wsAlive   = false;
    this.subIds    = [];    // 多个订阅 ID
    this.pingTimer = null;
    this.pollTimer = null;
    this.seenSigs  = new Set();
    this.seenMints = new Set();
  }

  isConnected() { return this.wsAlive; }
  onMigration(cb) { this.callbacks.push(cb); }

  connect() {
    console.log('[Helius] Starting pump.fun migration monitor v2...');
    console.log(`[Helius] Programs: BC=${PUMP_BC_PROGRAM.slice(0,8)}... AMM=${PUMP_AMM_PROGRAM.slice(0,12)}...`);
    this._connectWS();
    this._startPolling();
  }

  // ================================================================
  //  WEBSOCKET
  // ================================================================

  _connectWS() {
    console.log('[Helius] Connecting WebSocket...');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.wsAlive = true;
      console.log('[Helius] WebSocket connected ✓');
      this._subscribe();
      this._startPing();
    });

    this.ws.on('message', (data) => {
      try { this._handleMessage(JSON.parse(data.toString())); } catch (e) {}
    });

    this.ws.on('close', (code) => {
      this.wsAlive = false;
      this.subIds = [];
      this._stopPing();
      console.log(`[Helius] WS closed (${code}), reconnecting in 3s...`);
      setTimeout(() => this._connectWS(), 3000);
    });

    this.ws.on('error', (err) => console.error('[Helius] WS error:', err.message));
  }

  /**
   * 订阅两个 program 的日志
   * 用不同的 id 区分订阅响应
   */
  _subscribe() {
    // 订阅 1: Pump.fun Bonding Curve 主程序
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [PUMP_BC_PROGRAM] }, { commitment: 'confirmed' }],
    }));
    console.log('[Helius] logsSubscribe → Pump BC program');

    // 订阅 2: PumpSwap AMM 程序
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2,
      method: 'logsSubscribe',
      params: [{ mentions: [PUMP_AMM_PROGRAM] }, { commitment: 'confirmed' }],
    }));
    console.log('[Helius] logsSubscribe → PumpSwap AMM program');
  }

  _handleMessage(msg) {
    // 订阅确认
    if (msg.id === 1 || msg.id === 2) {
      if (msg.error) {
        console.error(`[Helius] logsSubscribe(${msg.id}) error:`, JSON.stringify(msg.error));
        return;
      }
      this.subIds.push(msg.result);
      const label = msg.id === 1 ? 'BC' : 'AMM';
      console.log(`[Helius] logsSubscribe ${label} confirmed (subId=${msg.result}) ✓`);
      return;
    }

    if (msg.result === 'pong') return;

    // 日志通知
    if (msg.method === 'logsNotification') {
      const value = msg.params?.result?.value;
      if (!value) return;
      const logs = value.logs || [];

      // WS 预过滤：宽松匹配，只要有迁移相关关键词就拉完整交易验证
      // 严格判断在 _parseTxFromRpc → _isMigrationLogs 中用完整日志做
      const mayBeMigration = logs.some(log =>
        log.includes('Migrate') ||
        log.includes('MigrateFunds') ||
        log.includes('CreatePool') ||
        log.includes('InitializePool')
      );
      if (!mayBeMigration) return;

      const sig = value.signature;
      if (!sig || this.seenSigs.has(sig)) return;
      this.seenSigs.add(sig);
      console.log(`[Helius] WS candidate: ${sig?.slice(0,8)}...`);
      this._parseTxFromRpc(sig).catch(err =>
        console.error(`[Helius] parseTx error (${sig?.slice(0,8)}):`, err.message)
      );
    }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  // ================================================================
  //  POLLING FALLBACK
  // ================================================================

  _startPolling() {
    this._pollInit().then(() => {
      this.pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
      console.log(`[Helius] Polling started (every ${POLL_INTERVAL_MS / 1000}s, ${SIGNATURES_LIMIT} sigs/batch, both programs)`);
    }).catch(err => {
      console.error('[Helius] Poll init error:', err.message);
      this.pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
    });
  }

  async _pollInit() {
    // 初始化：拉取两个 program 的最近签名做基线
    const [sigs1, sigs2] = await Promise.all([
      this._fetchSigs(PUMP_BC_PROGRAM),
      this._fetchSigs(PUMP_AMM_PROGRAM),
    ]);
    [...sigs1, ...sigs2].forEach(s => this.seenSigs.add(s.signature));
    console.log(`[Helius] Polling baseline: ${this.seenSigs.size} sigs`);
  }

  /**
   * 同时轮询两个 program（修复旧版只查一个的问题）
   */
  async _pollOnce() {
    try {
      await Promise.all([
        this._processNewSigs(PUMP_BC_PROGRAM),
        this._processNewSigs(PUMP_AMM_PROGRAM),
      ]);
    } catch (err) {
      console.error('[Helius] Poll error:', err.message);
    }
  }

  async _fetchSigs(program) {
    const res = await axios.post(this.rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [program, { limit: SIGNATURES_LIMIT, commitment: 'confirmed' }],
    }, { timeout: 10000 });
    return res.data?.result || [];
  }

  async _processNewSigs(program) {
    const sigs = await this._fetchSigs(program);
    const newSigs = sigs.filter(info => info.signature && !this.seenSigs.has(info.signature));

    for (const info of newSigs) {
      this.seenSigs.add(info.signature);
      // 不跳过 info.err，某些迁移有部分错误但实际已完成
      this._parseTxFromRpc(info.signature).catch(() => {});
    }

    // 防止 seenSigs 无限增长
    if (this.seenSigs.size > 5000) {
      const arr = Array.from(this.seenSigs);
      arr.slice(0, 2500).forEach(s => this.seenSigs.delete(s));
    }
  }

  // ================================================================
  //  TRANSACTION PARSING
  // ================================================================

  async _parseTxFromRpc(signature) {
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
    if (!tx) return;

    const logs = tx.meta?.logMessages || [];
    if (!this._isMigrationLogs(logs)) return;

    const mint = this._extractMint(tx);
    if (!mint) {
      console.log(`[Helius] mint extract failed sig=${signature.slice(0,8)}`);
      return;
    }

    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    const devAddress = this._extractDevAddress(tx);
    const dest = this._detectDestination(logs);

    console.log(`[Helius] ✅ Migration: mint=${mint} dev=${devAddress || 'unknown'} dest=${dest}`);
    this._emit(mint, signature, devAddress);
  }

  /**
   * 迁移日志判断（严格版）
   *
   * 真正的迁移交易特征：
   *
   * PumpSwap 路径（95%+ 自 2025.3）：
   *   - BC 程序 (6EF8r...) 被调用 + 日志含 "Migrate"
   *   - AND AMM 程序 (pAMMBay...) 被调用（创建池）
   *
   * Raydium 路径（少量旧版）：
   *   - 日志含 "MigrateFunds" 或 "InitializePool"
   *
   * 关键区别：单独出现 "Migrate" 可能是其他操作（如查询状态），
   * 必须同时看到 AMM 程序被 invoke 才是真正迁移完成
   */
  _isMigrationLogs(logs) {
    const joined = logs.join('\n');

    // 旧版 Raydium 迁移（保留兼容）
    if (joined.includes('MigrateFunds') || joined.includes('InitializePool')) {
      return true;
    }

    // PumpSwap 迁移：必须同时满足两个条件
    const hasBCMigrate = logs.some(log =>
      log.includes(PUMP_BC_PROGRAM) && log.includes('invoke')
    ) && logs.some(log =>
      log.includes('Program log: Migrate')
    );

    const hasAMMPool = logs.some(log =>
      log.includes(PUMP_AMM_PROGRAM) && log.includes('invoke')
    );

    // BC 程序发起 Migrate + AMM 程序被调用 = 真正迁移
    if (hasBCMigrate && hasAMMPool) return true;

    // 备用：AMM 程序 invoke + CreatePool 日志
    if (hasAMMPool && logs.some(log => log.includes('CreatePool'))) return true;

    return false;
  }

  /**
   * 从交易中提取 mint 地址（放宽版）
   *
   * 优先级：
   * 1. postTokenBalances 中以 'pump' 结尾的 mint
   * 2. preTokenBalances 中以 'pump' 结尾的 mint
   * 3. postTokenBalances 中第一个非 WSOL 的 SPL token mint（新版兼容）
   * 4. accountKeys 中以 'pump' 结尾的地址（最后手段）
   */
  _extractMint(tx) {
    const WSOL = 'So11111111111111111111111111111111111111112';

    // 优先：以 pump 结尾的 mint
    const post = tx.meta?.postTokenBalances || [];
    for (const b of post) {
      if (b.mint && b.mint.endsWith('pump')) return b.mint;
    }
    const pre = tx.meta?.preTokenBalances || [];
    for (const b of pre) {
      if (b.mint && b.mint.endsWith('pump')) return b.mint;
    }

    // Fallback：postTokenBalances 中第一个非 WSOL 的 mint
    for (const b of post) {
      if (b.mint && b.mint !== WSOL) return b.mint;
    }
    for (const b of pre) {
      if (b.mint && b.mint !== WSOL) return b.mint;
    }

    // 最后手段：accountKeys
    const keys = tx.transaction?.message?.accountKeys || [];
    for (const acc of keys) {
      const k = acc.pubkey || acc;
      if (typeof k === 'string' && k.endsWith('pump') && k.length > 30) return k;
    }

    return null;
  }

  /**
   * 提取 dev 地址
   * 迁移交易的发起者通常是 pump.fun 迁移钱包 (39az...)，
   * 真正的 dev（代币创建者）需要从其他 signer 中提取
   */
  _extractDevAddress(tx) {
    try {
      const keys = tx.transaction?.message?.accountKeys || [];
      for (const acc of keys) {
        const pubkey = acc.pubkey || acc;
        const isSigner   = acc.signer   ?? false;
        const isWritable = acc.writable ?? false;
        if (isSigner && isWritable && typeof pubkey === 'string') {
          // 跳过迁移钱包本身
          if (pubkey === MIGRATION_ACCOUNT) continue;
          return pubkey;
        }
      }
      // 如果只有迁移钱包是 signer（PumpSwap 自动迁移的情况），
      // 返回第一个 writable signer
      for (const acc of keys) {
        const pubkey = acc.pubkey || acc;
        const isSigner   = acc.signer   ?? false;
        const isWritable = acc.writable ?? false;
        if (isSigner && isWritable && typeof pubkey === 'string') {
          return pubkey;
        }
      }
    } catch (e) {}
    return null;
  }

  /**
   * 检测迁移目标（PumpSwap 或 Raydium），用于日志
   */
  _detectDestination(logs) {
    const hasAMM = logs.some(log => log.includes(PUMP_AMM_PROGRAM));
    if (hasAMM) return 'PumpSwap';
    const hasRaydium = logs.some(log =>
      log.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
    );
    if (hasRaydium) return 'Raydium';
    return 'unknown';
  }

  _emit(mint, signature, devAddress) {
    const event = { mint, signature, devAddress, symbol: null, name: null };
    for (const cb of this.callbacks) {
      cb(event).catch(e => console.error('[Helius] callback error:', e.message));
    }
  }

  stop() {
    this._stopPing();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.wsAlive = false;
    this.subIds = [];
    console.log('[Helius] Monitor stopped');
  }
}

module.exports = { HeliusMonitor };
