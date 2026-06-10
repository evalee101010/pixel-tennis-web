(function () {
  "use strict";

  const DEFAULT_MAX_MISSES = 100;
  const PING_MS = 1200;
  const MISS_DISPLAY_MS = 5200;

  function create(options = {}) {
    const maxMisses = Math.max(20, Number(options.maxMisses) || DEFAULT_MAX_MISSES);
    const state = {
      lastPingAt: 0,
      lastPongAt: 0,
      rttMs: null,
      serverTime: null,
      stateCount: 0,
      misses: [],
      counts: Object.create(null),
      lastDebug: null,
      lastDebugAt: 0,
      totals: {
        dx: 0,
        dy: 0,
        z: 0,
      },
    };

    function maybePing(now, sendOnline, force = false) {
      if (!force && now - state.lastPingAt < PING_MS) return;
      state.lastPingAt = now;
      sendOnline({ type: "ping", sentAt: now });
    }

    function handlePong(packet, now) {
      const sentAt = Number(packet.sentAt);
      if (Number.isFinite(sentAt)) state.rttMs = Math.max(0, now - sentAt);
      state.lastPongAt = now;
      state.serverTime = Number(packet.serverTime) || state.serverTime;
    }

    function handleState(packet) {
      state.stateCount += 1;
      state.serverTime = Number(packet.serverTime) || Number(packet.updatedAt) || state.serverTime;
    }

    function handleDebug(packet, playerId, now) {
      if (packet.event && packet.event !== "miss") return;
      const miss = {
        at: now,
        playerId: playerId || "unknown",
        reason: packet.reason || packet.code || "UNKNOWN",
        code: packet.code || "unknown",
        dx: safeNumber(packet.dx),
        dy: safeNumber(packet.dy),
        z: safeNumber(packet.z),
        limitX: safeNumber(packet.limitX),
        limitY: safeNumber(packet.limitY),
        cooldown: safeNumber(packet.cooldown),
      };
      state.lastDebug = miss;
      state.lastDebugAt = now;
      state.misses.push(miss);
      state.counts[miss.code] = (state.counts[miss.code] || 0) + 1;
      state.totals.dx += miss.dx || 0;
      state.totals.dy += miss.dy || 0;
      state.totals.z += miss.z || 0;
      if (state.misses.length > maxMisses) {
        const removed = state.misses.shift();
        state.counts[removed.code] = Math.max(0, (state.counts[removed.code] || 0) - 1);
        if (state.counts[removed.code] === 0) delete state.counts[removed.code];
        state.totals.dx -= removed.dx || 0;
        state.totals.dy -= removed.dy || 0;
        state.totals.z -= removed.z || 0;
      }
    }

    function summary() {
      const total = state.misses.length;
      const byCode = { ...state.counts };
      const latest = state.misses[state.misses.length - 1] || null;
      return {
        total,
        byCode,
        top: topReasons(byCode),
        avg: {
          dx: total ? round(state.totals.dx / total) : 0,
          dy: total ? round(state.totals.dy / total) : 0,
          z: total ? round(state.totals.z / total) : 0,
        },
        latest,
        rttMs: state.rttMs === null ? null : Math.round(state.rttMs),
        stateCount: state.stateCount,
      };
    }

    function reset() {
      state.misses.length = 0;
      state.counts = Object.create(null);
      state.lastDebug = null;
      state.lastDebugAt = 0;
      state.totals.dx = 0;
      state.totals.dy = 0;
      state.totals.z = 0;
    }

    function draw(ctx, view) {
      const now = performance.now();
      const online = view.online;
      const box = view.isPortrait
        ? { x: 14, y: 456, width: 268, height: 154 }
        : { x: 18, y: 186, width: 302, height: 154 };
      const stateAge = online.snapshotAt ? `${Math.round(now - online.snapshotAt)}ms` : "--";
      const rtt = state.rttMs === null ? "--" : `${Math.round(state.rttMs)}ms`;
      const inputAge = online.lastInputAt ? `${Math.round(now - online.lastInputAt)}ms` : "--";
      const pongAge = state.lastPongAt ? `${Math.round(now - state.lastPongAt)}ms` : "--";
      const role = String(online.playerId || "P?").toUpperCase();
      const room = online.room || "--";
      const missFresh = state.lastDebug && now - state.lastDebugAt < MISS_DISPLAY_MS;
      const miss = missFresh ? state.lastDebug : null;
      const report = summary();

      ctx.save();
      ctx.fillStyle = "rgba(3, 8, 12, 0.78)";
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.strokeStyle = view.stale ? "rgba(255, 92, 92, 0.88)" : "rgba(80, 245, 255, 0.76)";
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.fillStyle = "rgba(25, 74, 82, 0.42)";
      ctx.fillRect(box.x + 6, box.y + 6, box.width - 12, 22);

      debugText(ctx, "NET DEBUG", box.x + 12, box.y + 23, 12, "#d9fbff");
      debugText(ctx, `ROOM ${room} ${role}`, box.x + 12, box.y + 45, 11, "#fff0a6");
      debugText(ctx, `RTT ${rtt}  STATE ${stateAge}`, box.x + 12, box.y + 63, 11, "#aef5ff");
      debugText(ctx, `INPUT ${inputAge}  PONG ${pongAge}`, box.x + 12, box.y + 81, 11, "#b8e5ff");
      debugText(ctx, `MISS TOTAL ${report.total}  TOP ${topLine(report.top)}`, box.x + 12, box.y + 99, 10, "#c7ffc6");
      if (miss) {
        debugText(ctx, `LAST ${miss.reason}`, box.x + 12, box.y + 117, 10, "#ffd27a");
        debugText(ctx, `DX ${fmt(miss.dx)}/${fmt(miss.limitX)} DY ${fmt(miss.dy)}/${fmt(miss.limitY)} Z ${fmt(miss.z)}`, box.x + 12, box.y + 132, 9, "#ffb5a8");
      } else {
        debugText(ctx, "LAST --", box.x + 12, box.y + 117, 10, "#8ea4ad");
      }
      debugText(ctx, "console: PixelTennisDebug.summary()", box.x + 12, box.y + 148, 9, "#8fb4bd");
      ctx.restore();
    }

    return {
      maybePing,
      handlePong,
      handleState,
      handleDebug,
      summary,
      reset,
      recent: () => state.misses.slice(),
    };
  }

  function topReasons(counts) {
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, count]) => ({ code, count }));
  }

  function topLine(top) {
    if (!top.length) return "--";
    return top.map((item) => `${labelCode(item.code)}:${item.count}`).join(" ");
  }

  function labelCode(code) {
    return String(code || "--").replace(/_/g, " ").toUpperCase();
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function fmt(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return number.toFixed(1);
  }

  function debugText(ctx, text, x, y, size, color) {
    ctx.save();
    ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillText(text, Math.round(x + 2), Math.round(y + 2));
    ctx.fillStyle = color;
    ctx.fillText(text, Math.round(x), Math.round(y));
    ctx.restore();
  }

  window.PixelTennisNetDebug = { create };
})();
