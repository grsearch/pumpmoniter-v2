require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const axios = require('axios');

const { HeliusMonitor } = require('./helius');
const { BirdeyeService } = require('./birdeye');
const { SafetyChecker } = require('./safetyChecker');
const { TokenStore, FIRST_CHECK_MS, SECOND_CHECK_MS, PHASE_PENDING, PHASE_WATCH, PHASE_DONE } = require('./tokenStore');
const { WebhookService } = require('./webhook');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const store   = new TokenStore();
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
let phaseCheckTimer = null;  // 统一定时扫描器（每30秒检查到期的 token）

function isWorkingHour() {
  const nowUTC = new Date();
  const bjtMs  = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt    = new Date(bjtMs);
  const totalMin = bjt.getUTCHours() * 60 + bjt.getUTCMinutes();
  const startMin = WORK_START_BJT.hour * 60 + WORK_START_BJT.minute;
  const stopMin  = WORK_STOP_BJT.hour  * 60 + WORK_STOP_BJT.minute;
  return totalMin >= startMin && totalMin < stopMin;
}

function bjtTimeStr() {
  const nowUTC = new Date();
  const bjtMs  = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt    = new Date(bjtMs);
  const h = String(bjt.getUTCHours()).padStart(2, '0');
  const m = String(bjt.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m} BJT`;
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function startWork() {
  if (isWorking) return;
  isWorking = true;
  console.log(`\n▶️  [Schedule] Work START at ${bjtTimeStr()} — monitoring resumed`);
  helius.connect();
  // 每 30 秒扫描一次，检查是否有 token 到达检测时间点
  if (!phaseCheckTimer) phaseCheckTimer = setInterval(phaseCheckLoop, 30 * 1000);
  broadcast('schedule', { working: true, message: '监控已开启 (BJT 07:00)' });
}

function stopWork() {
  if (!isWorking) return;
  isWorking = false;
  console.log(`\n⏸️  [Schedule] Work STOP at ${bjtTimeStr()} — monitoring paused`);
  helius.stop();
  if (phaseCheckTimer) { clearInterval(phaseCheckTimer); phaseCheckTimer = null; }
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
  else console.log(`[Schedule] Outside working hours, paused until BJT 07:00`);
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => { checkSchedule(); setInterval(checkSchedule, 60 * 1000); }, msToNextMinute);
}

function checkSchedule() {
  const shouldWork = isWorkingHour();
  if (shouldWork && !isWorking)  startWork();
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
    total:          store.size(),
    heliusConnected: helius.isConnected(),
    uptime:         Math.floor(process.uptime()),
    webhookEnabled: webhook.enabled,
    webhookFired:   webhook.getFired().length,
    working:        isWorking,
    currentBJT:     bjtTimeStr(),
  });
});

app.get('/api/webhook/fired', (req, res) => {
  res.json({ fired: webhook.getFired() });
});

// =====================================================
// ✅ 处理迁移事件：立即收录，不查 FDV/LP
// =====================================================
async function processNewToken(mintAddress, symbol, name, devAddress) {
  if (!isWorking) return;
  if (store.get(mintAddress)) return;

  console.log(`\n[NEW] Migration detected: ${mintAddress} dev=${devAddress || 'unknown'}`);

  try {
    // 🛡️ Authority check（~1-2s，仅检查权限）
    const safetyResult = await safety.check(mintAddress);
    if (!safetyResult.safe) {
      console.log(`[REJECT] ${mintAddress}: ${safetyResult.reason}`);
      broadcast('token_skipped', { mint: mintAddress, reason: safetyResult.reason });
      return;
    }

    // 获取基础元数据（名称、logo 等），但不依赖 FDV/LP 决定是否收录
    let tokenMeta = null;
    try {
      tokenMeta = await birdeye.getTokenData(mintAddress);
    } catch (e) {
      console.warn(`[META] ${mintAddress} birdeye meta fetch failed: ${e.message}`);
    }

    const entry = {
      mint:           mintAddress,
      symbol:         tokenMeta?.symbol  || symbol || '???',
      name:           tokenMeta?.name    || name   || '',
      logoURI:        tokenMeta?.logoURI || '',
      addedAt:        Date.now(),
      // FDV/LP 暂不赋值，等 5 分钟后第一次检测再填
      lp:             0,
      fdv:            0,
      holders:        0,
      top10Pct:       null,
      devPct:         null,
      devAddress:     devAddress || null,
      price:          Number(tokenMeta?.price) || 0,
      priceChange24h: Number(tokenMeta?.priceChange24h) || 0,
    };

    store.add(entry);
    broadcast('token_added', entry);

    const firstCheckSec = Math.round(FIRST_CHECK_MS / 1000);
    console.log(`[ADD] $${entry.symbol} (${mintAddress.slice(0,8)}...) — phase=pending, 第一次检测将在 ${firstCheckSec}s 后执行`);

    // ⏱️ 精确在 5 分钟时触发第一次检测（不依赖轮询误差）
    const delay1 = FIRST_CHECK_MS - (Date.now() - entry.addedAt);
    setTimeout(() => runPhase1Check(mintAddress), Math.max(delay1, 0));

  } catch (err) {
    console.error(`[ERROR] processNewToken ${mintAddress}:`, err.message);
  }
}

// =====================================================
// ⏱️ 阶段 1：5 分钟后第一次检测 FDV/LP
// =====================================================
async function runPhase1Check(mint) {
  const raw = store._getRaw(mint);
  if (!raw) return;  // 已被移除（如休市清空）
  if (raw.phase !== PHASE_PENDING) return;

  console.log(`\n[PHASE1] 🔍 5min check: ${mint.slice(0,8)}... ($${raw.symbol})`);

  try {
    const data = await birdeye.getTokenData(mint);
    const lp  = Number(data?.liquidity) || 0;
    const fdv = Number(data?.fdv)       || 0;

    store.update(mint, {
      lp, fdv,
      holders:        Number(data?.holder)          || 0,
      price:          Number(data?.price)            || 0,
      priceChange24h: Number(data?.priceChange24h)   || 0,
      logoURI:        data?.logoURI || raw.logoURI,
      firstCheckAt:   Date.now(),
    });

    const phase1MinFdv = webhook.phase1MinFdv;
    const phase1MinLp  = webhook.phase1MinLp;

    if (fdv >= phase1MinFdv && lp >= phase1MinLp) {
      // ✅ 通过第一次检测，留存并安排 12 小时后第二次检测
      store.update(mint, { phase: PHASE_WATCH });
      const updated = store.get(mint);
      broadcast('token_updated', updated);

      const remaining12h = SECOND_CHECK_MS - (Date.now() - raw.addedAt);
      console.log(`[PHASE1] ✅ $${raw.symbol} PASS — FDV=$${fmtNum(fdv)} LP=$${fmtNum(lp)} | 进入 watch 阶段，${Math.round(remaining12h/3600000*10)/10}h 后第二次检测`);

      setTimeout(() => runPhase2Check(mint), Math.max(remaining12h, 0));

    } else {
      // ❌ 不符合，退出
      const reason = `Phase1 FAIL: FDV=$${fmtNum(fdv)} (需≥$${fmtNum(phase1MinFdv)}) LP=$${fmtNum(lp)} (需≥$${fmtNum(phase1MinLp)})`;
      console.log(`[PHASE1] ❌ $${raw.symbol} — ${reason}`);
      store.remove(mint);
      broadcast('token_removed', { mint, reason });
    }

  } catch (err) {
    console.error(`[PHASE1] Error for ${mint}:`, err.message);
    // 查询失败时保守处理：移除
    store.remove(mint);
    broadcast('token_removed', { mint, reason: 'Phase1 API error' });
  }
}

// =====================================================
// ⏱️ 阶段 2：12 小时后第二次检测 FDV/LP
// =====================================================
async function runPhase2Check(mint) {
  const raw = store._getRaw(mint);
  if (!raw) return;  // 已被移除（如休市清空）
  if (raw.phase !== PHASE_WATCH) return;

  console.log(`\n[PHASE2] 🔍 12h check: ${mint.slice(0,8)}... ($${raw.symbol})`);

  try {
    const data = await birdeye.getTokenData(mint);
    const lp  = Number(data?.liquidity) || 0;
    const fdv = Number(data?.fdv)       || 0;

    store.update(mint, {
      lp, fdv,
      holders:        Number(data?.holder)         || 0,
      price:          Number(data?.price)           || 0,
      priceChange24h: Number(data?.priceChange24h)  || 0,
      logoURI:        data?.logoURI || raw.logoURI,
      phase:          PHASE_DONE,
      secondCheckAt:  Date.now(),
    });

    const updated = store.get(mint);

    // 同时补充 holder 详情
    const holderStats = await fetchHolderStats(mint, raw.devAddress || null);
    if (store._getRaw(mint)) {
      store.update(mint, holderStats);
    }
    const finalToken = store.get(mint);

    broadcast('token_updated', finalToken || updated);

    // 检查是否触发 webhook
    const fired = await webhook.checkAndFire(finalToken || updated);

    if (fired) {
      console.log(`[PHASE2] ✅ $${raw.symbol} PASS & webhook fired — FDV=$${fmtNum(fdv)} LP=$${fmtNum(lp)}`);
    } else {
      console.log(`[PHASE2] ⬇️  $${raw.symbol} NO webhook — FDV=$${fmtNum(fdv)} LP=$${fmtNum(lp)}`);
    }

  } catch (err) {
    console.error(`[PHASE2] Error for ${mint}:`, err.message);
  }

  // 无论结果如何，退出监控
  console.log(`[PHASE2] 🏁 $${raw.symbol} — 退出监控系统`);
  store.remove(mint);
  broadcast('token_removed', { mint, reason: 'Phase2 完成，退出监控' });
}

// =====================================================
// 🔄 定期扫描（每 30 秒）：兜底补救，防止 setTimeout 丢失
//    正常情况下 setTimeout 已精准触发，此处作为保险
// =====================================================
async function phaseCheckLoop() {
  if (!isWorking) return;
  const tokens = store.getAll();
  const now = Date.now();

  for (const token of tokens) {
    if (token.phase === PHASE_PENDING) {
      const due = token.addedAt + FIRST_CHECK_MS;
      // 如果已超时 5 分钟以上还在 pending（setTimeout 未触发），补救执行
      if (now >= due + 30000) {
        console.log(`[LOOP] 补救执行 Phase1 for $${token.symbol}`);
        runPhase1Check(token.mint).catch(console.error);
      }
    } else if (token.phase === PHASE_WATCH) {
      const due = token.addedAt + SECOND_CHECK_MS;
      if (now >= due + 30000) {
        console.log(`[LOOP] 补救执行 Phase2 for $${token.symbol}`);
        runPhase2Check(token.mint).catch(console.error);
      }
    }
  }
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
  console.log(`\n🚀 Pump Monitor v3 running at http://localhost:${PORT}`);
  console.log(`📡 Listening for pump.fun migrations via Helius...`);
  console.log(`🔑 Helius:   ${process.env.HELIUS_API_KEY  ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Birdeye:  ${process.env.BIRDEYE_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`🔔 Webhook:  ${process.env.WEBHOOK_URL ? `✓ → ${process.env.WEBHOOK_URL}` : '✗ not set'}`);
  console.log(`\n📋 监控逻辑：`);
  console.log(`   ① 迁移检测到 → 立即收录（不查 FDV/LP）`);
  console.log(`   ② +5分钟 → 第一次检测: FDV≥$${webhook.phase1MinFdv} 且 LP≥$${webhook.phase1MinLp} → 留存，否则退出`);
  console.log(`   ③ +12小时 → 第二次检测: FDV>$${webhook.phase2MinFdv} 且 LP>$${webhook.phase2MinLp} → 发送 webhook（无论是否符合都退出）`);
  console.log(`🕐 Schedule: BJT 07:00 – 23:30\n`);
});
