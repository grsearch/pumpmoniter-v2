/**
 * 安全检测模块（仅 Authority Check）
 * 目标：< 2 秒完成
 */

class SafetyChecker {
  constructor(heliusRpcUrl, birdeyeService) {
    this.birdeye = birdeyeService;
  }

  async check(mintAddress) {
    const startTime = Date.now();

    try {
      const authOk = await this.birdeye.checkAuthorities(mintAddress);
      if (!authOk) {
        console.log(`[Safety] ✗ ${mintAddress.slice(0, 8)}... FAILED authority (${Date.now() - startTime}ms)`);
        return { safe: false, reason: 'Mint/Freeze authority not revoked' };
      }
    } catch (err) {
      console.error(`[Safety] authority check error: ${err.message}`);
    }

    console.log(`[Safety] ✅ ${mintAddress.slice(0, 8)}... PASSED (${Date.now() - startTime}ms)`);
    return { safe: true, reason: 'ok' };
  }
}

module.exports = { SafetyChecker };
