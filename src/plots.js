/* ==========================================================================
   plots.js — 轻量 canvas 绘图原语（无依赖，DPR 感知）
   ========================================================================== */
const CV = (() => {

  function setup(canvas, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = cssH || canvas.clientHeight || 240;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  function axes(g, box, opt = {}) {
    const { x0, y0, x1, y1 } = box;
    const grid = opt.grid !== false;
    g.save();
    if (grid) {
      g.strokeStyle = 'rgba(234,231,224,.055)';
      g.lineWidth = 1;
      const nx = opt.nx || 4, ny = opt.ny || 4;
      for (let i = 0; i <= nx; i++) {
        const x = x0 + (x1 - x0) * i / nx;
        g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
      }
      for (let i = 0; i <= ny; i++) {
        const y = y0 + (y1 - y0) * i / ny;
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
      }
    }
    g.strokeStyle = 'rgba(234,231,224,.16)';
    g.beginPath();
    g.moveTo(x0, y0); g.lineTo(x0, y1); g.lineTo(x1, y1);
    g.stroke();
    g.restore();
  }

  function label(g, text, x, y, opt = {}) {
    g.save();
    g.fillStyle = opt.color || 'rgba(164,167,168,.85)';
    g.font = `${opt.size || 9.5}px ui-monospace,"SF Mono",Menlo,monospace`;
    g.textAlign = opt.align || 'left';
    g.textBaseline = opt.base || 'middle';
    if (opt.spacing) g.letterSpacing = opt.spacing + 'px';
    g.fillText(text, x, y);
    g.restore();
  }

  /* 平滑曲线绘制：单调三次插值，避免过冲 */
  function line(g, pts, mapX, mapY, opt = {}) {
    if (pts.length < 2) return;
    const P = pts.map(p => [mapX(p[0]), mapY(p[1])]);
    g.save();
    g.beginPath();
    g.moveTo(P[0][0], P[0][1]);
    for (let i = 1; i < P.length - 1; i++) {
      const mx = (P[i][0] + P[i + 1][0]) / 2;
      const my = (P[i][1] + P[i + 1][1]) / 2;
      g.quadraticCurveTo(P[i][0], P[i][1], mx, my);
    }
    const n = P.length;
    g.quadraticCurveTo(P[n - 2][0], P[n - 2][1], P[n - 1][0], P[n - 1][1]);
    g.lineWidth = opt.width || 1.6;
    g.strokeStyle = opt.color || '#e6a33d';
    if (opt.glow) {
      g.shadowColor = opt.color; g.shadowBlur = opt.glow;
    }
    g.stroke();
    g.restore();
  }

  function area(g, pts, mapX, mapY, baseY, color) {
    if (pts.length < 2) return;
    g.save();
    g.beginPath();
    g.moveTo(mapX(pts[0][0]), baseY);
    pts.forEach(p => g.lineTo(mapX(p[0]), mapY(p[1])));
    g.lineTo(mapX(pts[pts.length - 1][0]), baseY);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.restore();
  }

  function dot(g, x, y, r, color, ring) {
    g.save();
    if (ring) {
      g.beginPath(); g.arc(x, y, r + 4.5, 0, 7);
      g.fillStyle = ring; g.fill();
    }
    g.beginPath(); g.arc(x, y, r, 0, 7);
    g.fillStyle = color; g.fill();
    g.restore();
  }

  function vline(g, x, y0, y1, color, dash) {
    g.save();
    g.setLineDash(dash || [3, 3]);
    g.strokeStyle = color; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
    g.restore();
  }

  function hline(g, y, x0, x1, color, dash) {
    g.save();
    g.setLineDash(dash || [3, 3]);
    g.strokeStyle = color; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.restore();
  }

  /* 波长 → 可视颜色（简易近似，仅用于说明「颜色=光谱」） */
  function wlColor(l, a = 1) {
    let r = 0, g = 0, b = 0;
    if (l >= 380 && l < 440) { r = -(l - 440) / 60; b = 1; }
    else if (l < 490) { g = (l - 440) / 50; b = 1; }
    else if (l < 510) { g = 1; b = -(l - 510) / 20; }
    else if (l < 580) { r = (l - 510) / 70; g = 1; }
    else if (l < 645) { r = 1; g = -(l - 645) / 65; }
    else if (l <= 780) { r = 1; }
    let f = 1;
    if (l < 420) f = 0.3 + 0.7 * (l - 380) / 40;
    else if (l > 700) f = 0.3 + 0.7 * (780 - l) / 80;
    const q = v => Math.round(255 * Math.pow(Math.max(0, v) * f, 0.85));
    return `rgba(${q(r)},${q(g)},${q(b)},${a})`;
  }

  function spectrumBar(g, x0, y0, w, h, WL) {
    const n = 64;
    for (let i = 0; i < n; i++) {
      const l = WL[0] + (WL[WL.length - 1] - WL[0]) * i / (n - 1);
      g.fillStyle = wlColor(l);
      g.fillRect(x0 + w * i / n, y0, w / n + 0.7, h);
    }
  }

  return { setup, axes, label, line, area, dot, vline, hline, wlColor, spectrumBar };
})();
