const WebSocket = require('ws');
const axios = require('axios');

// ============================================================
// pump.fun 相关地址
// ============================================================
const PUMP_BC_PROGRAM  = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_MIGRATION_WALLET = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';

// ============================================================
// LetsBonk.fun (Raydium LaunchLab) 相关地址
// ============================================================
const BONK_LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vbjFwE73TzqUD9p9FAJpuDHbRmAG';
const BONK_CPMM_PROGRAM      = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
// LaunchLab 迁移时由该钱包发起 CPMM CreatePool 交易
const BONK_MIGRATION_WALLET  = 'FdCu4hFBFT8UnKjGsGHBmGwWJRZxuHGBQhqFJKwEMB3j';

const STANDARD_WS_URL  = (apiKey) => `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const RPC_URL          = (apiKey) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const POLL_INTERVAL_MS = 5 * 1000;
const SIGNATURES_LIMIT = 100;
const PING_INTERVAL_MS = 30 * 1000;

// 来源标记，方便日志区分
const SOURCE_PUMP = 'pump.fun';
const SOURCE_BONK = 'letsbonk';

class HeliusMonitor {
  constructor(apiKey) {
    this.apiKey    = apiKey;
    this.rpcUrl    = RPC_URL(apiKey);
    this.wsUrl     = STANDARD_WS_URL(apiKey);
    this.callbacks = [];
    this.ws        = null;
    this.wsAlive   = false;
    this.subIds    = {};       // { pump: subId, bonk: subId }
    this.pingTimer = null;
    this.pollTimer = null;
    this.seenSigs  = new Set();
    this.seenMints = new Set();
  }

  isConnected() { return this.wsAlive; }
  onMigration(cb) { this.callbacks.push(cb); }

  connect() {
    console.log('[Helius] Starting pump.fun + LetsBonk migration monitor...');
    this._connectWS();
    this._startPolling();
  }

  // ──────────────────────────────────────────────
  // WebSocket
  // ──────────────────────────────────────────────
  _connectWS() {
    console.log('[Helius] Connecting WebSocket...');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.wsAlive = true;
      console.log('[Helius] WebSocket connected ✓');
      this._subscribePump();
      this._subscribeBonk();
      this._startPing();
    });

    this.ws.on('message', (data) => {
      try { this._handleMessage(JSON.parse(data.toString())); } catch (e) {}
    });

    this.ws.on('close', (code) => {
      this.wsAlive = false;
      this.subIds  = {};
      this._stopPing();
      console.log(`[Helius] WS closed (${code}), reconnecting in 5s...`);
      setTimeout(() => this._connectWS(), 5000);
    });

    this.ws.on('error', (err) => console.error('[Helius] WS error:', err.message));
  }

  _subscribePump() {
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 10,
      method: 'logsSubscribe',
      params: [{ mentions: [PUMP_BC_PROGRAM] }, { commitment: 'confirmed' }],
    }));
    console.log('[Helius] logsSubscribe → pump.fun BC program');
  }

  _subscribeBonk() {
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 11,
      method: 'logsSubscribe',
      params: [{ mentions: [BONK_LAUNCHLAB_PROGRAM] }, { commitment: 'confirmed' }],
    }));
    console.log('[Helius] logsSubscribe → LetsBonk LaunchLab program');
  }

  _handleMessage(msg) {
    // 订阅确认
    if (msg.id === 10) {
      if (msg.error) { console.error('[Helius] pump subscribe error:', JSON.stringify(msg.error)); return; }
      this.subIds.pump = msg.result;
      console.log(`[Helius] pump.fun subscribe OK (subId=${msg.result}) ✓`);
      return;
    }
    if (msg.id === 11) {
      if (msg.error) { console.error('[Helius] bonk subscribe error:', JSON.stringify(msg.error)); return; }
      this.subIds.bonk = msg.result;
      console.log(`[Helius] LetsBonk subscribe OK (subId=${msg.result}) ✓`);
      return;
    }
    if (msg.result === 'pong') return;

    if (msg.method === 'logsNotification') {
      const value = msg.params?.result?.value;
      if (!value || value.err) return;

      const logs = value.logs || [];
      const sig  = value.signature;

      // 判断来源
      const isPump = this._isPumpMigrationLogs(logs);
      const isBonk = this._isBonkMigrationLogs(logs);

      if (!isPump && !isBonk) return;

      const source = isPump ? SOURCE_PUMP : SOURCE_BONK;
      console.log(`[Helius] WS migration log [${source}]: ${sig?.slice(0, 8)}...`);

      this._parseTxFromRpc(sig, source).catch(err =>
        console.error(`[Helius] parseTx error (${sig?.slice(0, 8)}):`, err.message)
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

  // ──────────────────────────────────────────────
  // Polling fallback（轮询两个迁移钱包）
  // ──────────────────────────────────────────────
  _startPolling() {
    this._pollInit().then(() => {
      this.pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
      console.log(`[Helius] Polling started (every ${POLL_INTERVAL_MS / 1000}s) — pump + bonk wallets`);
    }).catch(err => {
      console.error('[Helius] Poll init error:', err.message);
      this.pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
    });
  }

  async _pollInit() {
    const [pumpSigs, bonkSigs] = await Promise.all([
      this._fetchSigs(PUMP_MIGRATION_WALLET),
      this._fetchSigs(BONK_MIGRATION_WALLET),
    ]);
    pumpSigs.forEach(s => this.seenSigs.add(s.signature));
    bonkSigs.forEach(s => this.seenSigs.add(s.signature));
    console.log(`[Helius] Polling baseline: ${this.seenSigs.size} sigs (pump=${pumpSigs.length} bonk=${bonkSigs.length})`);
  }

  async _pollOnce() {
    try {
      await Promise.all([
        this._processNewSigs(PUMP_MIGRATION_WALLET, SOURCE_PUMP),
        this._processNewSigs(BONK_MIGRATION_WALLET, SOURCE_BONK),
      ]);
    } catch (err) { console.error('[Helius] Poll error:', err.message); }
  }

  async _fetchSigs(address) {
    const res = await axios.post(this.rpcUrl, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [address, { limit: SIGNATURES_LIMIT, commitment: 'confirmed' }],
    }, { timeout: 10000 });
    return res.data?.result || [];
  }

  async _processNewSigs(address, source) {
    const sigs = await this._fetchSigs(address);
    for (const info of sigs) {
      if (!info.signature || this.seenSigs.has(info.signature)) continue;
      this.seenSigs.add(info.signature);
      if (info.err) continue;
      this._parseTxFromRpc(info.signature, source).catch(() => {});
    }
    if (this.seenSigs.size > 10000) {
      const arr = Array.from(this.seenSigs);
      arr.slice(0, 5000).forEach(s => this.seenSigs.delete(s));
    }
  }

  // ──────────────────────────────────────────────
  // 解析交易
  // ──────────────────────────────────────────────
  async _parseTxFromRpc(signature, source) {
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

    // 验证确实是迁移交易
    const validPump = source === SOURCE_PUMP && this._isPumpMigrationLogs(logs);
    const validBonk = source === SOURCE_BONK && this._isBonkMigrationLogs(logs);
    if (!validPump && !validBonk) return;

    const mint = source === SOURCE_PUMP
      ? this._extractPumpMint(tx)
      : this._extractBonkMint(tx);

    if (!mint) {
      const post = tx.meta?.postTokenBalances || [];
      console.log(`[Helius][${source}] mint extract failed sig=${signature.slice(0, 8)} mints=${JSON.stringify(post.map(b => b.mint))}`);
      return;
    }

    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    const devAddress = this._extractDevAddress(tx);
    console.log(`[Helius] ✅ [${source}] Migration: mint=${mint} dev=${devAddress || 'unknown'}`);
    this._emit(mint, signature, devAddress, source);
  }

  // ──────────────────────────────────────────────
  // Log 匹配：pump.fun
  // ──────────────────────────────────────────────
  _isPumpMigrationLogs(logs) {
    return logs.some(log =>
      log.includes('MigrateFunds') ||
      log.includes('CreatePool')   ||
      log.includes('InitializePool')
    );
  }

  // ──────────────────────────────────────────────
  // Log 匹配：LetsBonk (LaunchLab → Raydium CPMM)
  // ──────────────────────────────────────────────
  _isBonkMigrationLogs(logs) {
    const hasLaunchLab = logs.some(log => log.includes(BONK_LAUNCHLAB_PROGRAM));
    const hasMigrate   = logs.some(log =>
      log.includes('MigrateToAmm') ||
      log.includes('Migrate')      ||
      log.includes('CreatePool')   ||
      log.includes('initialize2')  ||    // Raydium CPMM initialize
      log.includes('InitializePool')
    );
    // 必须同时包含 LaunchLab 程序调用 + 迁移相关 log
    return hasLaunchLab && hasMigrate;
  }

  // ──────────────────────────────────────────────
  // Mint 提取：pump.fun（mint 以 'pump' 结尾）
  // ──────────────────────────────────────────────
  _extractPumpMint(tx) {
    const post = tx.meta?.postTokenBalances || [];
    for (const b of post) { if (b.mint?.endsWith('pump')) return b.mint; }
    const pre = tx.meta?.preTokenBalances || [];
    for (const b of pre)  { if (b.mint?.endsWith('pump')) return b.mint; }
    const keys = tx.transaction?.message?.accountKeys || [];
    for (const acc of keys) {
      const k = acc.pubkey || acc;
      if (typeof k === 'string' && k.endsWith('pump') && k.length > 30) return k;
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Mint 提取：LetsBonk (LaunchLab)
  // LetsBonk token 地址无特定后缀，从 postTokenBalances 中
  // 排除稳定币/WSOL/BONK，选非 pump 的 token mint
  // ──────────────────────────────────────────────
  _extractBonkMint(tx) {
    const WSOL    = 'So11111111111111111111111111111111111111112';
    const BONK    = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const USDC    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT    = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const EXCLUDE = new Set([WSOL, BONK, USDC, USDT]);

    // 优先从 postTokenBalances 找
    const post = tx.meta?.postTokenBalances || [];
    for (const b of post) {
      if (!b.mint) continue;
      if (EXCLUDE.has(b.mint)) continue;
      if (b.mint.endsWith('pump')) continue;   // 排除 pump.fun token
      if (b.mint.length >= 32) return b.mint;   // 有效 Solana 地址长度
    }
    // 再从 preTokenBalances 找
    const pre = tx.meta?.preTokenBalances || [];
    for (const b of pre) {
      if (!b.mint) continue;
      if (EXCLUDE.has(b.mint)) continue;
      if (b.mint.endsWith('pump')) continue;
      if (b.mint.length >= 32) return b.mint;
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Dev 地址提取（第一个 signer+writable）
  // ──────────────────────────────────────────────
  _extractDevAddress(tx) {
    try {
      const keys = tx.transaction?.message?.accountKeys || [];
      for (const acc of keys) {
        const pubkey     = acc.pubkey || acc;
        const isSigner   = acc.signer   ?? false;
        const isWritable = acc.writable ?? false;
        if (isSigner && isWritable && typeof pubkey === 'string') return pubkey;
      }
    } catch (e) {}
    return null;
  }

  _emit(mint, signature, devAddress, source) {
    const event = { mint, signature, devAddress, source, symbol: null, name: null };
    for (const cb of this.callbacks) {
      cb(event).catch(e => console.error('[Helius] callback error:', e.message));
    }
  }

  stop() {
    this._stopPing();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.ws)        { this.ws.close(); this.ws = null; }
    this.wsAlive = false;
    console.log('[Helius] Monitor stopped');
  }
}

module.exports = {
  HeliusMonitor,
  SOURCE_PUMP,
  SOURCE_BONK,
};
