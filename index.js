require('dotenv').config();
const express   = require('express');
const WebSocket = require('ws');
const http      = require('http');
const path      = require('path');

const { HeliusMonitor, SOURCE_PUMP } = require('./helius');
const { BirdeyeService } = require('./birdeye');
const { SafetyChecker }  = require('./safetyChecker');
const { TokenStore, MAX_KEEP_MS } = require('./tokenStore');
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
// Birdeye 数据拉取的重试参数
// 迁移那一刻 Birdeye 可能尚未索引到新池子，做几次短重试
// ──────────────────────────────────────────────────────────
const FETCH_MAX_TRIES   = Number(process.env.FETCH_MAX_TRIES)   || 4;
const FETCH_RETRY_MS    = Number(process.env.FETCH_RETRY_MS)    || 2000;
const CLEANUP_LOOP_MS   = 60 * 1000;

// ──────────────────────────────────────────────────────────
// 工作时间控制（北京时间 07:00 – 23:30）
// ──────────────────────────────────────────────────────────
const WORK_START_BJT = { hour: 7,  minute: 0  };
const WORK_STOP_BJT  = { hour: 23, minute: 30 };

let isWorking    = false;
let cleanupTimer = null;

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
  if (!cleanupTimer) cleanupTimer = setInterval(cleanupLoop, CLEANUP_LOOP_MS);
  broadcast('schedule', { working: true, message: '监控已开启 (BJT 07:00)' });
}

function stopWork() {
  if (!isWorking) return;
  isWorking = false;
  console.log(`\n⏸️  [Schedule] Work STOP at ${bjtTimeStr()}`);
  helius.stop();
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
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
  if (ok && !isWorking)      startWork();
  else if (!ok && isWorking) stopWork();
}

// ──────────────────────────────────────────────────────────
// 定期清理：移除超过 MAX_KEEP_MS 的旧记录，避免内存膨胀
// ──────────────────────────────────────────────────────────
function cleanupLoop() {
  if (!isWorking) return;
  const now = Date.now();
  for (const t of store.getAll()) {
    if (now - t.addedAt >= MAX_KEEP_MS) {
      store.remove(t.mint);
      broadcast('token_removed', { mint: t.mint, reason: '已过期清理' });
    }
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
// 迁移事件处理：安全检查 → 拉取数据 → 满足阈值即发 webhook
// ──────────────────────────────────────────────────────────
async function processNewToken(mintAddress, symbol, name, source) {
  if (!isWorking) return;
  if (store.get(mintAddress)) return;

  console.log(`\n[NEW] [${source}] ${mintAddress}`);

  try {
    // ── 1. Authority 安全检测 ──
    const safetyResult = await safety.check(mintAddress);
    if (!safetyResult.safe) {
      console.log(`[REJECT] ${mintAddress}: ${safetyResult.reason}`);
      broadcast('token_skipped', { mint: mintAddress, reason: safetyResult.reason });
      return;
    }

    // ── 2. 拉取 Birdeye 数据（带重试，迁移那一刻可能尚未索引）──
    let data = null;
    for (let i = 1; i <= FETCH_MAX_TRIES; i++) {
      try {
        data = await birdeye.getTokenData(mintAddress);
      } catch (e) {
        console.warn(`[Birdeye] try ${i}/${FETCH_MAX_TRIES} ${mintAddress.slice(0,8)}... ${e.message}`);
      }
      const liq = Number(data?.liquidity) || 0;
      const fdv = Number(data?.fdv)       || 0;
      // 数据已可用（任意一个非零即视为已索引），跳出重试
      if (liq > 0 || fdv > 0) break;
      if (i < FETCH_MAX_TRIES) await sleep(FETCH_RETRY_MS);
    }

    const lp      = Number(data?.liquidity) || 0;
    const fdv     = Number(data?.fdv)       || 0;
    const holders = Number(data?.holder)    || 0;
    const price   = Number(data?.price)     || 0;
    const priceChange24h = Number(data?.priceChange24h) || 0;

    const entry = {
      mint:           mintAddress,
      symbol:         data?.symbol  || symbol || '???',
      name:           data?.name    || name   || '',
      logoURI:        data?.logoURI || '',
      source:         source,
      addedAt:        Date.now(),
      lp,
      fdv,
      holders,
      price,
      priceChange24h,
      webhookFiredAt: null,
    };

    store.add(entry);
    broadcast('token_added', entry);
    console.log(
      `[ADD] $${entry.symbol} (${mintAddress.slice(0,8)}...) [${source}]` +
      ` FDV=$${fmtNum(fdv)} LP=$${fmtNum(lp)} H=${holders}`
    );

    // ── 3. webhook 判断（FDV≥$20K & LP≥$5K）──
    const fired = await webhook.checkAndFire(entry);
    if (fired) {
      store.update(mintAddress, { webhookFiredAt: Date.now() });
      console.log(`[WH] 🔔 $${entry.symbol} webhook sent`);
    } else {
      const minFdv = webhook.fireMinFdv;
      const minLp  = webhook.fireMinLp;
      console.log(
        `[WH] ⏭️  $${entry.symbol} 不满足条件` +
        ` (FDV=$${fmtNum(fdv)} need≥$${fmtNum(minFdv)},` +
        ` LP=$${fmtNum(lp)} need≥$${fmtNum(minLp)})`
      );
    }

  } catch (err) {
    console.error(`[ERROR] processNewToken ${mintAddress}:`, err.message);
  }
}

// ──────────────────────────────────────────────────────────
// 工具
// ──────────────────────────────────────────────────────────
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
  console.log(`📡 仅监控 pump.fun 迁移事件`);
  console.log(`🔑 Helius:  ${process.env.HELIUS_API_KEY  ? '✓' : '✗ MISSING'}`);
  console.log(`🔑 Birdeye: ${process.env.BIRDEYE_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`🔔 Webhook: ${process.env.WEBHOOK_URL ? `✓ → ${process.env.WEBHOOK_URL}` : '✗ not set'}`);
  console.log(`\n📋 监控流程：`);
  console.log(`   ① pump.fun 迁移触发 → Authority 安全检测`);
  console.log(`   ② 通过 → 拉取 Birdeye 数据（FDV / LP / holders）`);
  console.log(`   ③ FDV ≥ $${webhook.fireMinFdv} 且 LP ≥ $${webhook.fireMinLp} → 立即发 webhook`);
  console.log(`🕐 Schedule: BJT 07:00 – 23:30\n`);
});
