require('dotenv').config();
const express   = require('express');
const WebSocket = require('ws');
const http      = require('http');
const path      = require('path');
const axios     = require('axios');

const { HeliusMonitor, SOURCE_PUMP, SOURCE_BONK } = require('./helius');
const { BirdeyeService }  = require('./birdeye');
const { SafetyChecker }   = require('./safetyChecker');
const {
  TokenStore,
  FIRST_CHECK_MS,
  WATCH_MIN_MS,
  MAX_WATCH_MS,
  PHASE_PENDING,
  PHASE_WATCH,
  PHASE_DONE,
} = require('./tokenStore');
const { WebhookService } = require('./webhook');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const store   = new TokenStore();
const birdeye = new BirdeyeService(process.env.BIRDEYE_API_KEY);
const helius  = new HeliusMonitor(process.env.HELIUS_API_KEY);
const safety  = new SafetyChecker(HELIUS_RPC_URL, birdeye);
const webhook = new WebhookService();
webhook.setBroadcast(broadcast);

// ──────────────────────────────────────────────────────────
// 刷新间隔常量
// ──────────────────────────────────────────────────────────
const WATCH_REFRESH_MS  = 5  * 60 * 1000;   // Phase 2：每 5 分钟刷新 FDV/LP/holders
const X_REFRESH_MS      = 15 * 60 * 1000;   // Phase 2：每 15 分钟刷新 X mentions

// ──────────────────────────────────────────────────────────
// 工作时间控制（北京时间 07:00 – 23:30）
// ──────────────────────────────────────────────────────────
const WORK_START_BJT = { hour: 7,  minute: 0  };
const WORK_STOP_BJT  = { hour: 23, minute: 30 };

let isWorking      = false;
let watchLoopTimer = null;   // Phase 2 刷新循环（每 5 分钟）
let guardTimer     = null;   // 兜底扫描（每 60 秒）

function isWorkingHour() {
  const nowUTC   = new Date();
  const bjtMs    = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt      = new Date(bjtMs);
  const totalMin = bjt.getUTCHours() * 60 + bjt.getUTCMinutes();
  const startMin = WORK_START_BJT.hour * 60 + WORK_START_BJT.minute;
  const stopMin  = WORK_STOP_BJT.hour  * 60 + WORK_STOP_BJT.minute;
  return totalMin >= startMin && totalMin < stopMin;
}

function bjtTimeStr() {
  const nowUTC = new Date();
  const bjtMs  = nowUTC.getTime() + 8 * 60 * 60 * 1000;
  const bjt    = new Date(bjtMs);
  return `${String(bjt.getUTCHours()).padStart(2,'0')}:${String(bjt.getUTCMinutes()).padStart(2,'0')} BJT`;
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function startWork() {
  if (isWorking) return;
  isWorking = true;
  console.log(`\n▶️  [Schedule] Work START at ${bjtTimeStr()}`);
  helius.connect();
  if (!watchLoopTimer) watchLoopTimer = setInterval(watchRefreshLoop, WATCH_REFRESH_MS);
  if (!guardTimer)     guardTimer     = setInterval(guardLoop, 60 * 1000);
  broadcast('schedule', { working: true, message: '监控已开启 (BJT 07:00)' });
}

function stopWork() {
  if (!isWorking) return;
  isWorking = false;
  console.log(`\n⏸️  [Schedule] Work STOP at ${bjtTimeStr()}`);
  helius.stop();
  if (watchLoopTimer) { clearInterval(watchLoopTimer); watchLoopTimer = null; }
  if (guardTimer)     { clearInterval(guardTimer);     guardTimer = null; }
  store.getAll().forEach(t => {
    store.remove(t.mint);
    broadcast('token_removed', { mint: t.mint, reason: '休市清空' });
  });
  broadcast('schedule', { working: false, message: '监控已暂停 (BJT 23:30)，将于 07:00 恢复' });
}

function startScheduler() {
  const ok = isWorkingHour();
  console.log(`[Schedule] Init at ${bjtTimeStr()} — should work: ${ok}`);
  if (ok) startWork();
  else console.log(`[Schedule] Outside working hours, waiting for BJT 07:00`);
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => { checkSchedule(); setInterval(checkSchedule, 60 * 1000); }, msToNextMinute);
}

function checkSchedule() {
  const ok = isWorkingHour();
  if (ok && !isWorking)   startWork();
  else if (!ok && isWorking) stopWork();
}

// ──────────────────────────────────────────────────────────
// Holder count via Helius RPC
// ──────────────────────────────────────────────────────────
async function fetchHolderCount(mintAddress) {
  try {
    let total = 0, page = 1;
    while (true) {
      const res = await axios.post(HELIUS_RPC_URL, {
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccounts',
        params: { mint: mintAddress, limit: 1000, page },
      }, { timeout: 15000 });
      const accounts = res.data?.result?.token_accounts;
      if (!Array.isArray(accounts) || accounts.length === 0) break;
      total += accounts.length;
      if (accounts.length < 1000) break;
      page++;
    }
    return total;
  } catch (err) {
    console.error(`[Holders] fetchHolderCount error:`, err.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// REST API
// ──────────────────────────────────────────────────────────
app.get('/api/tokens', (req, res) => res.json(store.getAll()));

app.get('/api/stats', (req, res) => {
  res.json({
    total:           store.size(),
    heliusConnected: helius.isConnected(),
    uptime:          Math.floor(process.uptime()),
    webhookEnabled:  webhook.enabled,
    webhookFired:    webhook.getFired().length,
    working:         isWorking,
    currentBJT:      bjtTimeStr(),
  });
});

app.get('/api/webhook/fired', (req, res) => res.json({ fired: webhook.getFired() }));

// ──────────────────────────────────────────────────────────
// 收录新 token（迁移事件触发）
// ──────────────────────────────────────────────────────────
async function processNewToken(mintAddress, symbol, name, source) {
  if (!isWorking) return;
  if (store.get(mintAddress)) return;

  console.log(`\n[NEW] [${source}] ${mintAddress}`);

  try {
    // Authority check
    const safetyResult = await safety.check(mintAddress);
    if (!safetyResult.safe) {
      console.log(`[REJECT] ${mintAddress}: ${safetyResult.reason}`);
      broadcast('token_skipped', { mint: mintAddress, reason: safetyResult.reason });
      return;
    }

    // 获取基础元数据（symbol/name/logo），不看 FDV/LP
    let meta = null;
    try { meta = await birdeye.getTokenData(mintAddress); }
    catch (e) { console.warn(`[META] ${mintAddress} failed: ${e.message}`); }

    const entry = {
      mint:           mintAddress,
      symbol:         meta?.symbol  || symbol || '???',
      name:           meta?.name    || name   || '',
      logoURI:        meta?.logoURI || '',
      source:         source,
      addedAt:        Date.now(),
      phase:          PHASE_PENDING,
      // 数据占位
      lp:             0,
      fdv:            0,
      holders:        0,
      price:          Number(meta?.price)          || 0,
      priceChange24h: Number(meta?.priceChange24h) || 0,
      xMentions:      null,   // 当前 X mentions 数值
      xMentionsDelta: null,   // 较上次 15min 的增量
      lastXCheckAt:   null,
      firstCheckAt:   null,
      webhookFiredAt: null,
    };

    store.add(entry);
    broadcast('token_added', entry);
    console.log(`[ADD] $${entry.symbol} (${mintAddress.slice(0,8)}...) [${source}] — 等待 5min 第一次检测`);

    // 精确在 5 分钟后触发
    const delay = FIRST_CHECK_MS - (Date.now() - entry.addedAt);
    setTimeout(() => runPhase1Check(mintAddress), Math.max(delay, 0));

  } catch (err) {
    console.error(`[ERROR] processNewToken ${mintAddress}:`, err.message);
  }
}

// ──────────────────────────────────────────────────────────
// Phase 1：+5 分钟检测
// ──────────────────────────────────────────────────────────
async function runPhase1Check(mint) {
  const raw = store._getRaw(mint);
  if (!raw || raw.phase !== PHASE_PENDING) return;

  console.log(`\n[P1] 🔍 5min check — $${raw.symbol} (${mint.slice(0,8)}...)`);

  try {
    const data = await birdeye.getTokenData(mint);
    const lp   = Number(data?.liquidity) || 0;
    const fdv  = Number(data?.fdv)       || 0;

    store.update(mint, {
      lp, fdv,
      holders:        Number(data?.holder)         || 0,
      price:          Number(data?.price)           || 0,
      priceChange24h: Number(data?.priceChange24h)  || 0,
      logoURI:        data?.logoURI || raw.logoURI,
      firstCheckAt:   Date.now(),
    });

    const minFdv = webhook.phase1MinFdv;
    const minLp  = webhook.phase1MinLp;

    if (fdv >= minFdv && lp >= minLp) {
      store.update(mint, { phase: PHASE_WATCH });
      const updated = store.get(mint);
      broadcast('token_updated', updated);
      console.log(`[P1] ✅ PASS $${raw.symbol} — FDV=$${fmtNum(fdv)} LP=$${fmtNum(lp)} → 进入 watch 阶段`);
      // Phase 2 刷新由 watchRefreshLoop 接管，不再单独 setTimeout
    } else {
      const reason = `P1 FAIL FDV=$${fmtNum(fdv)}(需≥$${fmtNum(minFdv)}) LP=$${fmtNum(lp)}(需≥$${fmtNum(minLp)})`;
      console.log(`[P1] ❌ $${raw.symbol} — ${reason}`);
      removeToken(mint, reason);
    }

  } catch (err) {
    console.error(`[P1] Error $${raw.symbol}:`, err.message);
    removeToken(mint, 'Phase1 API error');
  }
}

// ──────────────────────────────────────────────────────────
// Phase 2：watch 刷新循环（每 5 分钟由 setInterval 驱动）
// ──────────────────────────────────────────────────────────
async function watchRefreshLoop() {
  if (!isWorking) return;
  const tokens = store.getAll().filter(t => t.phase === PHASE_WATCH);
  if (tokens.length === 0) return;

  for (const token of tokens) {
    await refreshWatchToken(token.mint);
    await sleep(400); // 避免 API 并发
  }
}

async function refreshWatchToken(mint) {
  const raw = store._getRaw(mint);
  if (!raw || raw.phase !== PHASE_WATCH) return;

  const ageMs = Date.now() - raw.addedAt;

  // ── 12 小时到期，强制退出 ──
  if (ageMs >= MAX_WATCH_MS) {
    console.log(`[P2] ⏰ $${raw.symbol} — 12h 到期，退出监控`);
    removeToken(mint, '12h 监控期满，退出');
    return;
  }

  try {
    const data = await birdeye.getTokenData(mint);
    const lp   = Number(data?.liquidity) || 0;
    const fdv  = Number(data?.fdv)       || 0;

    // ── 随时退出条件 ──
    const minFdv = webhook.watchMinFdv;
    const minLp  = webhook.watchMinLp;
    if (fdv < minFdv || lp < minLp) {
      const reason = `P2 EXIT FDV=$${fmtNum(fdv)} LP=$${fmtNum(lp)} 低于阈值`;
      console.log(`[P2] ❌ $${raw.symbol} — ${reason}`);
      removeToken(mint, reason);
      return;
    }

    // ── 更新数据 ──
    const updates = {
      lp, fdv,
      price:          Number(data?.price)          || 0,
      priceChange24h: Number(data?.priceChange24h) || 0,
      logoURI:        data?.logoURI || raw.logoURI,
    };

    // holders（用 Birdeye 字段，省去 Helius 大量分页请求）
    const birdeyeHolders = Number(data?.holder) || 0;
    if (birdeyeHolders > 0) updates.holders = birdeyeHolders;

    // ── X mentions（每 15 分钟查一次）──
    const now         = Date.now();
    const lastX       = raw.lastXCheckAt || 0;
    if (now - lastX >= X_REFRESH_MS) {
      const mentions = await birdeye.getXMentions(mint);
      if (mentions !== null) {
        const prev  = raw.xMentions;                          // 上次的值
        const delta = prev !== null ? mentions - prev : null; // null = 第一次，无法计算增量
        updates.xMentions      = mentions;
        updates.xMentionsDelta = delta;
        updates.lastXCheckAt   = now;
        console.log(
          `[X] $${raw.symbol} mentions=${mentions}` +
          (delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta})` : ' (首次)')
        );
      } else {
        updates.lastXCheckAt = now; // 即使查不到也更新时间，避免频繁重试
      }
    }

    store.update(mint, updates);
    const updated = store.get(mint);
    broadcast('token_updated', updated);

    // ── webhook 检查（满 6h 后，每次刷新都判断，只发一次）──
    if (!raw.webhookFiredAt) {
      const fired = await webhook.checkAndFire(updated, ageMs);
      if (fired) {
        store.update(mint, { webhookFiredAt: Date.now() });
        console.log(`[P2] 🔔 $${raw.symbol} webhook sent`);
      }
    }

    const xDisplay = (() => {
      const cur   = updates.xMentions      ?? raw.xMentions;
      const delta = updates.xMentionsDelta ?? raw.xMentionsDelta;
      if (cur === null || cur === undefined) return '-';
      if (delta === null || delta === undefined) return String(cur);
      return `${cur}(${delta >= 0 ? '+' : ''}${delta})`;
    })();
    const ageH = (ageMs / 3600000).toFixed(1);
    console.log(
      `[P2] $${raw.symbol} | age=${ageH}h` +
      ` FDV=$${fmtNum(fdv)} LP=$${fmtNum(lp)}` +
      ` H=${updates.holders ?? raw.holders}` +
      ` X=${xDisplay}`
    );

  } catch (err) {
    console.error(`[P2] refreshWatchToken $${raw.symbol}:`, err.message);
  }
}

// ──────────────────────────────────────────────────────────
// 兜底扫描（每 60 秒）：补救 setTimeout 丢失 & 到期 token
// ──────────────────────────────────────────────────────────
async function guardLoop() {
  if (!isWorking) return;
  const now    = Date.now();
  const tokens = store.getAll();

  for (const token of tokens) {
    if (token.phase === PHASE_PENDING) {
      // 超过 6 分钟还在 pending，补救执行 Phase1
      if (now - token.addedAt >= FIRST_CHECK_MS + 60000) {
        console.log(`[Guard] 补救 P1 $${token.symbol}`);
        runPhase1Check(token.mint).catch(console.error);
      }
    } else if (token.phase === PHASE_WATCH) {
      // 超过 12h 强制退出
      if (now - token.addedAt >= MAX_WATCH_MS + 60000) {
        console.log(`[Guard] 补救超时退出 $${token.symbol}`);
        removeToken(token.mint, '12h 到期（guard）');
      }
    }
  }
}

// ──────────────────────────────────────────────────────────
// 工具
// ──────────────────────────────────────────────────────────
function removeToken(mint, reason) {
  store.remove(mint);
  broadcast('token_removed', { mint, reason });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtNum(n) {
  const v = Number(n);
  if (!v || isNaN(v)) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ──────────────────────────────────────────────────────────
// Helius 事件
// ──────────────────────────────────────────────────────────
helius.onMigration(async (event) => {
  await processNewToken(event.mint, event.symbol, event.name, event.source);
});

// ──────────────────────────────────────────────────────────
// WebSocket & 启动
// ──────────────────────────────────────────────────────────
startScheduler();

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'schedule', data: { working: isWorking, currentBJT: bjtTimeStr() }, ts: Date.now() }));
  ws.send(JSON.stringify({ type: 'init',     data: store.getAll(), ts: Date.now() }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] WS error:', err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Pump Monitor running at http://localhost:${PORT}`);
  console.log(`📡 pump.fun + LetsBonk 双平台监控`);
  console.log(`🔑 Helius:  ${process.env.HELIUS_API_KEY  ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Birdeye: ${process.env.BIRDEYE_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`🔔 Webhook: ${process.env.WEBHOOK_URL ? `✓ → ${process.env.WEBHOOK_URL}` : '✗ not set'}`);
  console.log(`\n📋 监控流程：`);
  console.log(`   ① 迁移 → 立即收录（仅 authority check，不查 FDV/LP）`);
  console.log(`   ② +5min → P1 检测: FDV≥$${webhook.phase1MinFdv} LP≥$${webhook.phase1MinLp} → 留存，否则退出`);
  console.log(`   ③ watch 阶段: 每 5min 刷新 FDV/LP/holders，每 15min 刷新 X mentions`);
  console.log(`      · FDV<$${webhook.watchMinFdv} 或 LP<$${webhook.watchMinLp} → 随时退出`);
  console.log(`      · ≥6h 且 FDV>$${webhook.fireMinFdv} LP>$${webhook.fireMinLp} → 发 webhook`);
  console.log(`      · ≥12h → 强制退出`);
  console.log(`🕐 Schedule: BJT 07:00 – 23:30\n`);
});
