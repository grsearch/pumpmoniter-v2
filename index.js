require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const axios = require('axios');

const { HeliusMonitor } = require('./helius');
const { BirdeyeService } = require('./birdeye');
const { SafetyChecker } = require('./safetyChecker');
const { TokenStore, STABLE_INTERVAL_MS } = require('./tokenStore');
const { WebhookService } = require('./webhook');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const store = new TokenStore();

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const birdeye = new BirdeyeService(process.env.BIRDEYE_API_KEY);
const helius  = new HeliusMonitor(process.env.HELIUS_API_KEY);
const safety  = new SafetyChecker(HELIUS_RPC_URL, birdeye);
const webhook = new WebhookService();
webhook.setBroadcast(broadcast);

// ========================================================
// ⏰ 工作时间控制（北京时间 07:00 – 23:30）
// ========================================================
const WORK_START_BJT = { hour: 7,  minute: 0  };
const WORK_STOP_BJT  = { hour: 23, minute: 30 };

let isWorking = false;
let refreshTimer = null;
let holderRefreshTimer = null;

function isWorkingHour() {
  const nowUTC = new Date();
  const bjtMs = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt = new Date(bjtMs);
  const h = bjt.getUTCHours();
  const m = bjt.getUTCMinutes();
  const totalMin = h * 60 + m;
  const startMin = WORK_START_BJT.hour * 60 + WORK_START_BJT.minute;
  const stopMin  = WORK_STOP_BJT.hour  * 60 + WORK_STOP_BJT.minute;
  return totalMin >= startMin && totalMin < stopMin;
}

function bjtTimeStr() {
  const nowUTC = new Date();
  const bjtMs = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt = new Date(bjtMs);
  const h = String(bjt.getUTCHours()).padStart(2, '0');
  const m = String(bjt.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m} BJT`;
}

function startWork() {
  if (isWorking) return;
  isWorking = true;
  console.log(`\n▶️  [Schedule] Work START at ${bjtTimeStr()} — monitoring resumed`);
  helius.connect();
  if (!refreshTimer) refreshTimer = setInterval(refreshLoop, 30 * 1000);
  if (!holderRefreshTimer) holderRefreshTimer = setInterval(holderStatsRefreshLoop, 90 * 1000);
  broadcast('schedule', { working: true, message: '监控已开启 (BJT 07:00)' });
}

function stopWork() {
  if (!isWorking) return;
  isWorking = false;
  console.log(`\n⏸️  [Schedule] Work STOP at ${bjtTimeStr()} — monitoring paused`);
  helius.stop();
  if (refreshTimer)       { clearInterval(refreshTimer);       refreshTimer = null; }
  if (holderRefreshTimer) { clearInterval(holderRefreshTimer); holderRefreshTimer = null; }
  store.getAll().forEach(t => {
    store.remove(t.mint);
    broadcast('token_removed', { mint: t.mint, reason: '休市清空' });
  });
  broadcast('schedule', { working: false, message: '监控已暂停 (BJT 23:30)，将于 07:00 恢复' });
}

function startScheduler() {
  const shouldWork = isWorkingHour();
  console.log(`[Schedule] Init at ${bjtTimeStr()} — should work: ${shouldWork}`);
  if (shouldWork) startWork();
  else { console.log(`[Schedule] Outside working hours, paused until BJT 07:00`); isWorking = false; }
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => { checkSchedule(); setInterval(checkSchedule, 60 * 1000); }, msToNextMinute);
}

function checkSchedule() {
  const shouldWork = isWorkingHour();
  if (shouldWork && !isWorking) startWork();
  else if (!shouldWork && isWorking) stopWork();
}

// ========== Helius RPC: holder stats ==========
async function fetchHolderStats(mintAddress, devAddress) {
  try {
    let allAccounts = [];
    let page = 1;
    while (true) {
      const res = await axios.post(HELIUS_RPC_URL, {
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccounts',
        params: { mint: mintAddress, limit: 1000, page },
      }, { timeout: 15000 });
      const accounts = res.data?.result?.token_accounts;
      if (!Array.isArray(accounts) || accounts.length === 0) break;
      allAccounts = allAccounts.concat(accounts);
      if (accounts.length < 1000) break;
      page++;
    }
    if (allAccounts.length === 0) return { holders: 0, top10Pct: null, devPct: null };

    const totalSupply = allAccounts.reduce((sum, a) => sum + Number(a.amount || 0), 0);
    if (totalSupply === 0) return { holders: allAccounts.length, top10Pct: null, devPct: null };

    allAccounts.sort((a, b) => Number(b.amount) - Number(a.amount));
    const top10Sum = allAccounts.slice(0, 10).reduce((sum, a) => sum + Number(a.amount || 0), 0);
    const top10Pct = (top10Sum / totalSupply) * 100;

    let devPct = null;
    if (devAddress) {
      const devAccount = allAccounts.find(a => a.owner === devAddress);
      devPct = devAccount ? (Number(devAccount.amount || 0) / totalSupply) * 100 : 0;
    }

    return { holders: allAccounts.length, top10Pct, devPct };
  } catch (err) {
    console.error(`[Stats] fetchHolderStats error:`, err.message);
    return { holders: 0, top10Pct: null, devPct: null };
  }
}

// ========== REST API ==========
app.get('/api/tokens', (req, res) => res.json(store.getAll()));

app.get('/api/stats', (req, res) => {
  res.json({
    total: store.size(),
    heliusConnected: helius.isConnected(),
    uptime: Math.floor(process.uptime()),
    webhookEnabled: webhook.enabled,
    webhookFired: webhook.getFired().length,
    working: isWorking,
    currentBJT: bjtTimeStr(),
  });
});

app.get('/api/webhook/fired', (req, res) => {
  res.json({ fired: webhook.getFired() });
});

// ========== Process new migration event ==========
async function processNewToken(mintAddress, symbol, name, devAddress) {
  if (!isWorking) return;
  if (store.get(mintAddress)) {
    console.log(`[SKIP] ${mintAddress} already tracked`);
    return;
  }

  console.log(`\n[NEW] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[NEW] Migration detected: ${mintAddress}`);
  console.log(`[NEW] Dev: ${devAddress || 'unknown'}`);

  try {
    // ══════════════════════════════════════════════
    // 🛡️ 前置安全检测（authority + bundle）
    // ══════════════════════════════════════════════
    const safetyResult = await safety.check(mintAddress, devAddress);

    if (!safetyResult.safe) {
      console.log(`[REJECT] ${mintAddress} blocked at ${safetyResult.stage}: ${safetyResult.risk}`);
      broadcast('token_skipped', {
        mint: mintAddress,
        stage: safetyResult.stage,
        risk: safetyResult.risk,
        reason: safetyResult.stage === 'authority'
          ? 'Authority not revoked'
          : safetyResult.bundleDetails?.reason,
        devAddress,
      });
      return;
    }

    // ══════════════════════════════════════════════
    // ✅ 安全检测通过，获取基本数据并入库
    // ══════════════════════════════════════════════
    const tokenData = await birdeye.getTokenData(mintAddress);
    if (!tokenData) { console.log(`[SKIP] ${mintAddress} no token data`); return; }

    const entry = {
      mint:           mintAddress,
      symbol:         tokenData.symbol || symbol || '???',
      name:           tokenData.name   || name   || '',
      logoURI:        tokenData.logoURI || '',
      addedAt:        Date.now(),
      lp:             Number(tokenData.liquidity)      || 0,
      fdv:            Number(tokenData.fdv)            || 0,
      holders:        0,
      top10Pct:       null,
      devPct:         null,
      devAddress:     devAddress || null,
      price:          Number(tokenData.price)          || 0,
      priceChange24h: Number(tokenData.priceChange24h) || 0,
      // 安全检测结果
      bundleRisk:     safetyResult.bundleRisk,
      bundleDetails:  safetyResult.bundleDetails,
    };

    store.add(entry);
    store.recordLpFdv(mintAddress, entry.lp, entry.fdv);
    broadcast('token_added', entry);

    console.log(
      `[ADD] $${entry.symbol} | LP=$${fmtNum(entry.lp)} FDV=$${fmtNum(entry.fdv)}` +
      ` | bundle=${safetyResult.bundleRisk}`
    );

    // ══════════════════════════════════════════════
    // 🔄 异步任务（不阻塞主流程）
    // ══════════════════════════════════════════════

    // Holder stats
    fetchHolderStats(mintAddress, devAddress).then(stats => {
      if (!store.get(mintAddress)) return;
      store.update(mintAddress, stats);
      broadcast('token_updated', store.get(mintAddress));
    });

  } catch (err) {
    console.error(`[ERROR] processNewToken ${mintAddress}:`, err.message);
  }
}

// ========== Data refresh loop (Birdeye, 每30秒) ==========
async function refreshLoop() {
  if (!isWorking) return;
  const tokens = store.getAll();
  if (tokens.length === 0) return;

  for (const token of tokens) {
    try {
      const data = await birdeye.getTokenData(token.mint);
      if (!data) { await sleep(300); continue; }

      const newLp  = Number(data.liquidity ?? token.lp)  || 0;
      const newFdv = Number(data.fdv       ?? token.fdv) || 0;
      const birdeyeHolders = Number(data.holder) || 0;

      store.update(token.mint, {
        lp:             newLp,
        fdv:            newFdv,
        holders:        birdeyeHolders || token.holders,
        price:          Number(data.price          ?? token.price)          || 0,
        priceChange24h: Number(data.priceChange24h ?? token.priceChange24h) || 0,
        logoURI:        data.logoURI || token.logoURI,
      });

      store.recordLpFdv(token.mint, newLp, newFdv);

      const updated = store.get(token.mint);
      if (!updated) { await sleep(300); continue; }

      const stable = store.getStableReading(token.mint);

      if (shouldExit(updated, stable)) {
        const reason = getExitReason(updated, stable);
        console.log(`[EXIT] $${updated.symbol} — ${reason}`);
        store.remove(token.mint);
        broadcast('token_removed', { mint: token.mint, reason });
        await sleep(300);
        continue;
      }

      broadcast('token_updated', updated);
      webhook.check(updated, stable).catch(() => {});
      await sleep(300);

    } catch (err) {
      console.error(`[ERROR] refreshLoop $${token.symbol}:`, err.message);
      await sleep(300);
    }
  }
}

// ========== Holder stats 刷新（每90秒）==========
async function holderStatsRefreshLoop() {
  if (!isWorking) return;
  const tokens = store.getAll();
  for (const token of tokens) {
    const stats = await fetchHolderStats(token.mint, token.devAddress || null);
    if (!store.get(token.mint)) continue;
    const changed =
      stats.holders  !== token.holders  ||
      stats.top10Pct !== token.top10Pct ||
      stats.devPct   !== token.devPct;
    if (changed) {
      store.update(token.mint, stats);
      const updated = store.get(token.mint);
      broadcast('token_updated', updated);
      webhook.check(updated, store.getStableReading(token.mint)).catch(() => {});
    }
    await sleep(1000);
  }
}

// ========== 退出条件 ==========
function getAgeHours(token) { return (Date.now() - token.addedAt) / 3600000; }

function shouldExit(token, stable) {
  const ageH = getAgeHours(token);
  if (ageH > 1) return true;
  if (ageH > 0.25 && stable && stable.fdv > 0 && stable.fdv < 20000) return true;
  return false;
}

function getExitReason(token, stable) {
  const ageH = getAgeHours(token);
  if (ageH > 1) return 'Age > 1H';
  if (ageH > 0.25 && stable && stable.fdv < 20000) return `FDV $${fmtNum(stable.fdv)} < $20K (age>15min)`;
  return 'Unknown';
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function fmtNum(n) {
  const v = Number(n);
  if (!v || isNaN(v)) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ========== Helius 事件监听 ==========
helius.onMigration(async (event) => {
  await processNewToken(event.mint, event.symbol, event.name, event.devAddress || null);
});

// ========== 启动 ==========
startScheduler();

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({
    type: 'schedule',
    data: { working: isWorking, currentBJT: bjtTimeStr() },
    ts: Date.now(),
  }));
  ws.send(JSON.stringify({ type: 'init', data: store.getAll(), ts: Date.now() }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] Client error:', err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Pump Monitor running at http://localhost:${PORT}`);
  console.log(`📡 Listening for pump.fun migrations via Helius...`);
  console.log(`🔑 Helius:   ${process.env.HELIUS_API_KEY   ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Birdeye:  ${process.env.BIRDEYE_API_KEY  ? '✓' : '✗ MISSING'}`);
  console.log(`🔔 Webhook:  ${process.env.WEBHOOK_URL ? `✓ → ${process.env.WEBHOOK_URL}` : '✗ not set'}`);
  console.log(`   Thresholds: FDV≥$${process.env.WEBHOOK_MIN_FDV || 25000} LP≥$${process.env.WEBHOOK_MIN_LP || 5000} Holders≥${process.env.WEBHOOK_MIN_HOLDERS || 10}`);
  console.log(`🛡️  Safety: authority → bundle (high≥${process.env.BUNDLE_HIGH_THRESHOLD || 5}, med≥${process.env.BUNDLE_MED_THRESHOLD || 3})`);
  console.log(`⏱  Stable check interval: ${STABLE_INTERVAL_MS / 60000} min`);
  console.log(`🕐 Schedule: BJT 07:00 – 23:30\n`);
});
