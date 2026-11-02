/* ==========================================================================
   app.js — 页面交互编排
   ========================================================================== */
(() => {
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hex = a => '#' + a.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const rgbStr = a => `rgb(${a.map(v => Math.round(clamp(v, 0, 255))).join(',')})`;
const fmt = (v, d = 2) => v.toFixed(d);

/* --------------------------------------------------------------------------
   全局状态
   -------------------------------------------------------------------------- */
const S = {
  film: 0,          // index into SP.FILMS
  paper: 0,         // index into SP.PAPERS
  latitude: 0.5,
  scene: 'portrait',
  texMode: 'grain',
  texAmount: 0.6,
  texScale: 1,
  split: 0.5,
  scanOn: false,
  hal: 1,
  diff: 0.5
};

let ENGINE = SP.build(SP.FILMS[S.film], SP.PAPERS[S.paper], S.latitude);

/* --------------------------------------------------------------------------
   合成场景 —— 一张纯计算出来的「测试片」，用于所有对比
   -------------------------------------------------------------------------- */
function sceneAt(u, v) {
  /* u,v ∈ [0,1]。返回线性 RGB。
     这是一张「实验台测试卡」：灰阶楔（考验曲线）、球体（连续渐变）、
     饱和色块（考验色彩分离）、纯黑区里的点光源（考验颗粒/卤化/扩散）。 */
  let r = 0.012, g = 0.012, b = 0.013;   // 底板：近乎中性黑

  // ---- 顶部：11 级灰阶楔（0.02 → 2.4 线性） ----
  if (v > 0.035 && v < 0.175) {
    const i = clamp(Math.floor((u - 0.04) / 0.92 * 11), 0, 10);
    const val = 0.018 * Math.pow(2.4 / 0.018, i / 10);
    r = val; g = val * 0.998; b = val * 0.996;
    return [r, g, b];
  }

  // ---- 左下：球体（连续渐变 + 高光 + 清晰的轮廓边） ----
  const SX = 0.225, SY = 0.545, SR = 0.168;
  const dx = (u - SX), dy = (v - SY) * 0.86;
  const sd = Math.hypot(dx, dy) / SR;
  if (sd < 1) {
    const nz = Math.sqrt(Math.max(0, 1 - sd * sd));
    const nx = dx / SR, ny = dy / SR;
    const lam = clamp(nx * -0.52 + ny * -0.60 + nz * 0.78, 0, 1);
    const spec = Math.pow(clamp(nx * -0.42 + ny * -0.52 + nz * 0.96, 0, 1), 48) * 3.2;
    const rim = Math.pow(1 - nz, 2.4) * 0.22;
    r = 0.030 + lam * 0.62 + spec + rim * 0.9;
    g = 0.026 + lam * 0.50 + spec * 0.97 + rim * 0.95;
    b = 0.024 + lam * 0.40 + spec * 0.92 + rim * 1.0;
    const edge = clamp((1 - sd) / 0.045, 0, 1);
    r *= 0.5 + 0.5 * edge; g *= 0.5 + 0.5 * edge; b *= 0.5 + 0.5 * edge;
    return [r, g, b];
  }

  // ---- 右上：2×3 饱和色块 ----
  const CX0 = 0.415, CX1 = 0.962, CY0 = 0.235, CY1 = 0.615;
  if (u > CX0 && u < CX1 && v > CY0 && v < CY1) {
    const cu = Math.min(2, Math.floor((u - CX0) / (CX1 - CX0) * 3));
    const cv2 = Math.min(1, Math.floor((v - CY0) / (CY1 - CY0) * 2));
    const chart = [
      [[0.80, 0.50, 0.38], [0.62, 0.065, 0.045], [0.075, 0.42, 0.10]],
      [[0.045, 0.11, 0.52], [0.78, 0.62, 0.045], [0.05, 0.36, 0.44]]
    ];
    const c = chart[cv2][cu];
    return [c[0], c[1], c[2]];
  }

  // ---- 右下：纯黑区里的点光源（卤化 / 扩散的主演） ----
  const LX = 0.585, LY = 0.795;
  const ld = Math.hypot((u - LX), (v - LY) * 0.92) / 0.030;
  if (ld < 1) {
    const s = Math.pow(1 - ld, 0.35) * 26.0;
    return [s, s * 0.985, s * 0.955];
  }
  // 光晕底座（一点环境散射，让光晕有落点）
  const halo = Math.pow(clamp(1 - ld / 7.5, 0, 1), 3.0) * 0.055;
  r += halo * 1.0; g += halo * 0.93; b += halo * 0.86;

  // ---- 右下：中性渐变条（考验滤色后的中性保持） ----
  if (u > 0.655 && u < 0.955 && v > 0.735 && v < 0.905) {
    const t = (u - 0.655) / 0.30;
    const val = 0.008 * Math.pow(0.85 / 0.008, t);
    return [val, val, val];
  }

  // ---- 左下：深部阶梯（考验 preflash / shadow shape） ----
  if (u > 0.045 && u < 0.185 && v > 0.745 && v < 0.935) {
    const step = clamp(Math.floor((v - 0.745) / 0.19 * 5), 0, 4);
    const val = [0.0009, 0.0026, 0.0065, 0.015, 0.034][step];
    return [val * 1.03, val, val * 0.97];
  }

  // 底板轻微渐变，避免死黑一块
  const vig = 1 - Math.hypot(u - 0.5, v - 0.5) * 0.5;
  return [r * vig, g * vig, b * vig];
}

/* --------------------------------------------------------------------------
   把场景渲染成 ImageData（对引擎调用做缓存）
   -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   渲染预算：拖动时降分辨率出图，松手后再补一帧全质量。
   目标是把单帧控制在 ~16ms（一帧的时间）以内。
   -------------------------------------------------------------------------- */
const RENDER_BUDGET_MS = 14;
let _rtStart = 0;
function budgetExceeded() { return performance.now() - _rtStart > RENDER_BUDGET_MS; }

/* 根据上一帧的实测耗时，决定这一帧用多大的画布 */
function pickScale(fullW, fullH, lastMs, minScale = 0.34) {
  if (!lastMs) return 1;
  if (lastMs <= RENDER_BUDGET_MS) return 1;
  const k = Math.sqrt(RENDER_BUDGET_MS / lastMs);
  return Math.max(minScale, Math.min(1, k));
}

/* 低分辨率渲染后放大到目标尺寸（双线性由 drawImage 代劳） */
function scaleImageData(img, w, h) {
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d').putImageData(img, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const g = dst.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

function renderScene(w, h, engine, opts = {}) {
  /* 场景是纯函数 sceneAt(u,v)，所以按 u/v 网格缓存每个像素的线性 RGB。
     同一尺寸下切换参数时，省掉重复的几何计算。 */
  const gkey = w + 'x' + h;
  let grid = sceneGridCache.get(gkey);
  if (!grid) {
    grid = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const c = sceneAt((x + 0.5) / w, v);
        const k = (y * w + x) * 3;
        grid[k] = c[0]; grid[k + 1] = c[1]; grid[k + 2] = c[2];
      }
    }
    if (sceneGridCache.size > 12) sceneGridCache.clear();
    sceneGridCache.set(gkey, grid);
  }

  const img = new ImageData(w, h);
  const d = img.data;
  const n = w * h;
  const tmp = new Float64Array(3);
  const out = new Float64Array(3);
  for (let p = 0; p < n; p++) {
    const k = p * 3;
    tmp[0] = grid[k]; tmp[1] = grid[k + 1]; tmp[2] = grid[k + 2];
    engine.renderInto(tmp, opts, out);
    const i = p * 4;
    d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = 255;
  }
  return img;
}

/* 带预算的自适应渲染：先试全尺寸，太慢就降 */
const _lastRenderMs = { v: 0 };
function renderSceneFast(w, h, engine, opts, minScale = 0.4) {
  const s = pickScale(w, h, _lastRenderMs.v, minScale);
  const rw = Math.max(2, Math.round(w * s));
  const rh = Math.max(2, Math.round(h * s));
  const t0 = performance.now();
  const img = renderScene(rw, rh, engine, opts);
  _lastRenderMs.v = performance.now() - t0;
  if (rw === w && rh === h) return img;
  return scaleImageData(img, w, h);
}
const sceneGridCache = new Map();

/* --------------------------------------------------------------------------
   纹理：颗粒 / 卤化 / 扩散（在成片像素上做后处理，保持视觉一致）
   -------------------------------------------------------------------------- */
function hash2(x, y, s) {
  let h = x * 374761393 + y * 668265263 + s * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), dd = hash2(xi + 1, yi + 1, s);
  return lerp(lerp(a, b, u), lerp(c, dd, u), v);
}

function applyTexture(img, mode, amount, scale) {
  const w = img.width, h = img.height, d = img.data;
  const out = new Uint8ClampedArray(d);
  const px = w * h;
  const lum = new Float32Array(px);
  for (let i = 0; i < px; i++) lum[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;

  const wantGrain = mode === 'grain' || mode === 'all';
  const wantHal = mode === 'halation' || mode === 'all';
  const wantDiff = mode === 'diffusion' || mode === 'all';

  /* 一维盒式模糊（滑动窗口，O(n)，与半径无关）。
     比逐像素内层循环快一个量级，视觉上足够——扩散本来就是柔和的。 */
  const _tmpF = new Float32Array(px);
  function boxBlur(src, dst, W, H, R) {
    const inv = 1 / (2 * R + 1);
    /* 横向：先算首列窗口和，然后滑动 */
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let s = 0;
      for (let k = -R; k <= R; k++) s += src[row + clamp(k, 0, W - 1)];
      for (let x = 0; x < W; x++) {
        dst[row + x] = s * inv;
        s += src[row + clamp(x + R + 1, 0, W - 1)] - src[row + clamp(x - R, 0, W - 1)];
      }
    }
  }
  /* 纵向：同样的滑动窗口 */
  function boxBlurY(src, dst, W, H, R) {
    const inv = 1 / (2 * R + 1);
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += src[clamp(k, 0, H - 1) * W + x];
      for (let y = 0; y < H; y++) {
        dst[y * W + x] = s * inv;
        s += src[clamp(y + R + 1, 0, H - 1) * W + x] - src[clamp(y - R, 0, H - 1) * W + x];
      }
    }
  }
  /* 两次盒式 ≈ 一次高斯 */
  function blur2(src, R) {
    boxBlur(src, _tmpF, w, h, R);
    const r = new Float32Array(px);
    boxBlurY(_tmpF, r, w, h, R);
    return r;
  }

  if (wantDiff) {
    /* 扩散：三个半径的加权模糊（core / halo / bloom），只向亮部借光 */
    const radii = [[1.6, 0.5], [5.2, 0.32], [13, 0.18]].map(r => [Math.max(1, r[0] * scale), r[1] * amount]);
    /* 先把亮度做 gamma 2.2 提升，再模糊；用查找表避免逐像素 pow */
    const LUTN = 1024;
    const gLUT = new Float32Array(LUTN + 1);
    for (let i = 0; i <= LUTN; i++) gLUT[i] = Math.pow(i / LUTN, 2.2);
    const hot = new Float32Array(px);
    for (let i = 0; i < px; i++) hot[i] = gLUT[(lum[i] * LUTN) | 0];

    const blurSum = new Float32Array(px);
    let wsum = 0;
    for (const [rad, wgt] of radii) {
      if (wgt <= 0) continue;
      const R = Math.round(rad);
      const b = blur2(hot, R);
      for (let i = 0; i < px; i++) blurSum[i] += b[i] * wgt;
      wsum += wgt;
    }
    if (wsum > 0) {
      const invW = 1 / wsum;
      /* 逆向 gamma 也用查找表 */
      const up = new Float32Array(LUTN + 1);
      for (let i = 0; i <= LUTN; i++) up[i] = Math.pow(i / LUTN, 1 / 2.2);
      for (let i = 0; i < px; i++) {
        const t = blurSum[i] * invW;
        const b = up[(clamp(t, 0, 1) * LUTN) | 0];
        const bleed = b * 0.85 * amount;
        out[i * 4] = d[i * 4] + bleed * 255 * 0.95;
        out[i * 4 + 1] = d[i * 4 + 1] + bleed * 255 * 0.9;
        out[i * 4 + 2] = d[i * 4 + 2] + bleed * 255 * 0.8;
        out[i * 4 + 3] = 255;
      }
    }
  }

  if (wantHal) {
    /* 卤化：只取高光，做大半径模糊，然后按 R>>G>B 加权叠加 */
    const LUTN = 1024;
    const hotLUT = new Float32Array(LUTN + 1);
    for (let i = 0; i <= LUTN; i++) hotLUT[i] = Math.pow(Math.max(0, i / LUTN - 0.55) / 0.45, 2.4);
    const hot = new Float32Array(px);
    for (let i = 0; i < px; i++) hot[i] = hotLUT[(lum[i] * LUTN) | 0];

    const rads = [[2.2, 0.30], [7, 0.42], [17, 0.28]];
    const acc = new Float32Array(px);
    for (const [rad, wg] of rads) {
      const R = Math.max(1, Math.round(rad * scale));
      const b = blur2(hot, R);
      for (let i = 0; i < px; i++) acc[i] += b[i] * wg;
    }
    const k = 0.62 * amount * S.hal;
    for (let i = 0; i < px; i++) {
      const a = acc[i] * k * 255;
      out[i * 4] = Math.min(255, out[i * 4] + a * 0.62);
      out[i * 4 + 1] = Math.min(255, out[i * 4 + 1] + a * 0.17);
      out[i * 4 + 2] = Math.min(255, out[i * 4 + 2] + a * 0.02);
    }
  }

  if (wantGrain) {
    /* 颗粒：粒子统计的视觉近似 —— 中间调方差最大 */
    const gs = 1.35 / Math.max(scale, 0.25);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const L = lum[i];
      const strength = Math.pow(4 * L * (1 - L), 0.75);
      let n = 0, amp = 1, freq = gs, tot = 0;
      for (let o = 0; o < 3; o++) {
        n += (vnoise(x * freq + o * 37.7, y * freq + o * 61.3, 7 + o * 13) - 0.5) * amp;
        tot += amp; amp *= 0.62; freq *= 2.1;
      }
      n /= tot;
      /* 单色 + 少量彩色分量（真实颗粒是 CMY 三层的叠加） */
      const cr = n * 1.0 + (hash2(x, y, 91) - 0.5) * 0.35;
      const cg = n * 1.0 + (hash2(x, y, 137) - 0.5) * 0.30;
      const cb = n * 1.0 + (hash2(x, y, 211) - 0.5) * 0.42;
      const k2 = strength * amount * 78;
      out[i * 4] = clamp(out[i * 4] + cr * k2, 0, 255);
      out[i * 4 + 1] = clamp(out[i * 4 + 1] + cg * k2, 0, 255);
      out[i * 4 + 2] = clamp(out[i * 4 + 2] + cb * k2, 0, 255);
    }
  }

  const res = new ImageData(w, h);
  res.data.set(out);
  return res;
}

/* --------------------------------------------------------------------------
   1. HERO —— 一条流动的「光谱-密度」带
   -------------------------------------------------------------------------- */
function initHero() {
  const cv = $('#heroCanvas');
  if (!cv) return;
  let W = 0, H = 0, dpr = 1, g;
  const N = 120;
  const parts = Array.from({ length: N }, () => ({
    x: Math.random(), y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00016,
    vy: (Math.random() - 0.5) * 0.00022,
    wl: 400 + Math.random() * 320,
    ph: Math.random() * 6.28,
    sz: 0.7 + Math.random() * 1.8
  }));

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  addEventListener('resize', resize);

  let t = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame() {
    t += reduce ? 0 : 0.004;
    g.clearRect(0, 0, W, H);

    /* 背景光晕 */
    const grd = g.createRadialGradient(W * 0.62, H * 0.42, 0, W * 0.62, H * 0.42, Math.max(W, H) * 0.72);
    grd.addColorStop(0, 'rgba(80,52,26,.20)');
    grd.addColorStop(0.45, 'rgba(28,32,40,.16)');
    grd.addColorStop(1, 'rgba(10,11,12,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    /* 粒子 —— 像光谱里的光子/银盐颗粒 */
    g.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      if (!reduce) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = 1; if (p.x > 1) p.x = 0;
        if (p.y < 0) p.y = 1; if (p.y > 1) p.y = 0;
      }
      const x = p.x * W + Math.sin(t * 1.1 + p.ph) * 10;
      const y = p.y * H + Math.cos(t * 0.9 + p.ph * 1.3) * 12;
      const c = CV.wlColor(p.wl, 0.5);
      const r = p.sz * 1.9;
      g.beginPath(); g.arc(x, y, r, 0, 7);
      g.fillStyle = c;
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';

    /* 一条正弦「曝光/密度」曲线，暗示胶片响应 */
    g.beginPath();
    for (let i = 0; i <= 80; i++) {
      const x = (i / 80) * W;
      const y = H * 0.5
        + Math.sin(i * 0.14 + t * 1.6) * H * 0.045
        + Math.sin(i * 0.052 - t * 0.9) * H * 0.075;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = 'rgba(230,163,61,.16)';
    g.lineWidth = 1;
    g.stroke();

    requestAnimationFrame(frame);
  }
  frame();
}

/* --------------------------------------------------------------------------
   2. 链条
   -------------------------------------------------------------------------- */
let curStation = 0;
function initChain() {
  const strip = $('#chainStrip'), body = $('#stationBody');
  if (!strip) return;

  strip.innerHTML = STATIONS.map((s, i) => `
    <button class="chain-st ${i === 0 ? 'on' : ''}" data-i="${i}" role="tab">
      <span class="dot"></span>
      <div class="n">STATION ${s.n}</div>
      <div class="t">${s.t}</div>
      <div class="u">${s.u}</div>
    </button>`).join('');

  function show(i) {
    curStation = i;
    const s = STATIONS[i];
    $$('.chain-st').forEach((b, k) => b.classList.toggle('on', k === i));
    body.style.opacity = 0;
    body.style.transform = 'translateY(6px)';
    setTimeout(() => {
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;align-items:flex-start">
          <div style="flex:1;min-width:260px">
            <h4>${s.t}</h4>
            <p style="color:var(--ink-2);max-width:60ch">${s.body}</p>
            <div class="lbl-row">${s.pills.map(p => `<span class="pill">${p}</span>`).join('')}</div>
            <div style="font-size:13px;color:var(--ink-3);line-height:1.7;border-left:1px solid var(--line-2);padding-left:14px">
              ${s.why}
            </div>
          </div>
          <div style="flex:0 1 400px;min-width:240px">
            <div class="card-t" style="margin-bottom:10px">输入 → 输出</div>
            <div style="display:grid;gap:8px">
              <div style="display:flex;gap:10px;align-items:center;font-size:12.5px">
                <span class="pill" style="background:rgba(255,255,255,.06)">IN</span>
                <span style="color:var(--ink-2)">${s.in}</span>
              </div>
              <div style="width:1px;height:14px;background:var(--line-2);margin-left:14px"></div>
              <div style="display:flex;gap:10px;align-items:center;font-size:12.5px">
                <span class="pill acc">OUT</span>
                <span style="color:var(--ink)">${s.out}</span>
              </div>
            </div>
            <div class="formula" style="margin-top:16px;font-size:11.5px;white-space:normal">${s.math}</div>
            <div style="margin-top:12px;font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;color:var(--ink-4)">
              UI GROUP · ${s.stage}
            </div>
          </div>
        </div>`;
      body.style.transition = 'opacity .4s var(--ease-out),transform .4s var(--ease-out)';
      body.style.opacity = 1;
      body.style.transform = 'none';
    }, 120);
  }

  strip.addEventListener('click', e => {
    const b = e.target.closest('.chain-st');
    if (b) show(+b.dataset.i);
  });

  /* 自动轮播一次，引导用户理解这是可点的 */
  show(0);
  let auto = null, userTouched = false;
  const io = new IntersectionObserver(en => {
    en.forEach(x => {
      if (x.isIntersecting && !userTouched && !auto) {
        let k = 0;
        auto = setInterval(() => {
          if (userTouched) return clearInterval(auto);
          k = (k + 1) % STATIONS.length;
          show(k);
        }, 2600);
      } else if (!x.isIntersecting && auto) {
        clearInterval(auto); auto = null;
      }
    });
  }, { threshold: 0.45 });
  io.observe(strip);
  strip.addEventListener('click', () => { userTouched = true; if (auto) clearInterval(auto); }, { once: true });
}

/* --------------------------------------------------------------------------
   3. 密度 → 透过率 交互
   -------------------------------------------------------------------------- */
function initDensity() {
  const s = $('#sDen'); if (!s) return;
  const paint = () => {
    const D = +s.value;
    const tr = Math.pow(10, -D);
    s.style.setProperty('--p', (D / 4 * 100) + '%');
    $('#oDen').textContent = fmt(D, 2);
    $('#oTrans').textContent = fmt(tr * 100, 1) + '%';
    $('#oLoss').textContent = fmt(D / 0.30103, 2) + ' EV';
    const v = Math.round(Math.pow(tr, 1 / 2.2) * 255);
    $('#denSwatch').style.background = `rgb(${v},${v},${v})`;
  };
  s.addEventListener('input', paint); paint();
}

/* --------------------------------------------------------------------------
   4. 光谱上采样
   -------------------------------------------------------------------------- */
function initSpectrum() {
  const cv = $('#cSpec'); if (!cv) return;
  let rgb = [0.55, 0.18, 0.06];
  let hover = -1;

  const film = SP.FILMS[S.film];
  const ILL = SP.WL.map(l => SP.planck(l, 5500));

  function draw() {
    const { g, w, h } = CV.setup(cv, 250);
    const box = { x0: 46, y0: 16, x1: w - 16, y1: h - 34 };
    CV.axes(g, box, { nx: 5, ny: 3 });

    const spec = SP.spectrumFromRGB(rgb, ILL);
    const mx = Math.max(...spec);

    const mapX = l => box.x0 + (l - SP.WL[0]) / (SP.WL[SP.WL.length - 1] - SP.WL[0]) * (box.x1 - box.x0);
    const mapY = v => box.y1 - v * (box.y1 - box.y0);

    /* 波长底色谱条 */
    CV.spectrumBar(g, box.x0, box.y1 + 6, box.x1 - box.x0, 7, SP.WL);

    /* 光谱 */
    const pts = SP.WL.map((l, i) => [l, spec[i] / mx]);
    CV.area(g, pts, mapX, mapY, box.y1, 'rgba(56,201,214,.13)');
    CV.line(g, pts, mapX, mapY, { color: '#38c9d6', width: 2, glow: 10 });

    /* 三层感光曲线（归一化到同一高度） */
    const cols = ['#ef5b4b', '#7bcf92', '#4d8df0'];
    for (let m = 0; m < 3; m++) {
      const raw = film.sens.map(r => Math.pow(10, r[m]));
      const mxx = Math.max(...raw);
      const p2 = SP.WL.map((l, i) => [l, raw[i] / mxx]);
      CV.line(g, p2, mapX, mapY, { color: cols[m], width: 1.2 });
    }

    /* 轴标 */
    CV.label(g, '380', box.x0, box.y1 + 22, { align: 'left', size: 9 });
    CV.label(g, '780 nm', box.x1, box.y1 + 22, { align: 'right', size: 9 });
    CV.label(g, 'rel. intensity', box.x0 - 8, box.y0, { align: 'right', size: 9 });
    CV.label(g, '1.0', box.x0 - 8, box.y0 + 2, { align: 'right', size: 8 });
    CV.label(g, '0', box.x0 - 8, box.y1, { align: 'right', size: 8 });

    /* hover */
    if (hover >= 0) {
      const l = SP.WL[hover];
      const xx = mapX(l);
      CV.vline(g, xx, box.y0, box.y1, 'rgba(255,255,255,.22)');
      CV.dot(g, xx, mapY(spec[hover] / mx), 3.5, '#38c9d6', 'rgba(56,201,214,.16)');
      const tip = $('#tipSpec');
      tip.style.left = xx + 'px'; tip.style.top = mapY(spec[hover] / mx) + 'px';
      tip.classList.add('on');
      tip.textContent = `${Math.round(l)} nm · ${(spec[hover] / mx).toFixed(2)}`;
    } else $('#tipSpec').classList.remove('on');
  }

  function pick(i) {
    hover = clamp(i, 0, SP.WL.length - 1); draw();
  }
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const box = { x0: 46, x1: r.width - 16 };
    const t = (x - box.x0) / (box.x1 - box.x0);
    pick(Math.round(t * (SP.WL.length - 1)));
  });
  cv.addEventListener('pointerleave', () => { hover = -1; draw(); });

  $('#specSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#specSeg button').forEach(x => x.classList.toggle('on', x === b));
    rgb = b.dataset.p.split(',').map(Number);
    draw();
  });
  $$('#specSeg button')[0].classList.add('on');
  addEventListener('resize', draw);
  draw();
}

/* --------------------------------------------------------------------------
   5. 特性曲线演示
   -------------------------------------------------------------------------- */
function initCurve() {
  const cv = $('#cCurve'); if (!cv) return;
  let workEV = 0;

  function draw() {
    const film = SP.FILMS[S.film];
    const { g, w, h } = CV.setup(cv, 300);
    const box = { x0: 52, y0: 20, x1: w - 104, y1: h - 46 };
    CV.axes(g, box, { nx: 5, ny: 4 });

    const x0 = film.le[0], x1 = film.le[film.le.length - 1];
    const dmax = Math.max(...film.d.flat());
    const mapX = x => box.x0 + (x - x0) / (x1 - x0) * (box.x1 - box.x0);
    const mapY = d => box.y1 - clamp(d / (dmax * 1.05), 0, 1) * (box.y1 - box.y0);

    const cols = ['#ef5b4b', '#7bcf92', '#4d8df0'];
    const names = ['R', 'G', 'B'];
    const push = S.pushVal || 0;
    const gamma = S.filmParams ? S.filmParams.gamma : 1;
    const eng0 = SP.build(film, SP.PAPERS[S.paper], S.latitude);

    /* push/pull：按插件公式重画（density = curve((logRaw+off) · γ · devTime)） */
    if (Math.abs(push) > 0.01) {
      const dev = push >= 0
        ? (push <= 1 ? Math.pow(220 / 180, push) : Math.pow(220 / 180, 1) * Math.pow(280 / 220, push - 1))
        : Math.pow(150 / 180, -push);
      for (let m = 0; m < 3; m++) {
        const p2 = [];
        const N = 240;
        for (let i = 0; i < N; i++) {
          const lx = x0 + (x1 - x0) * i / (N - 1);
          p2.push([lx, Math.max(0, SP.interp(film.le, film.d, (lx + eng0.calibrate.offF[m]) * gamma * dev, m))]);
        }
        CV.line(g, p2, mapX, mapY, { color: cols[m], width: 2.0 });
      }
    } else {
      for (let m = 0; m < 3; m++) {
        const p = SP.curvePoints(film, m, 240, gamma);
        CV.line(g, p, mapX, mapY, { color: cols[m], width: 1.9 });
      }
    }

    /* 每层的 18% 灰落点（三条竖虚线，展示层间差异） */
    eng0.calibrate.grayFm.forEach((gx, m) => {
      if (gx > x0 && gx < x1) {
        CV.vline(g, mapX(gx), box.y1 - 22, box.y1, cols[m] + '88', [2, 3]);
      }
    });

    const GRAY_LX = eng0.calibrate.grayFm[0];
    if (GRAY_LX > x0 && GRAY_LX < x1) {
      CV.label(g, '18% 灰', mapX(GRAY_LX) + 6, box.y0 + 11,
        { size: 8.5, color: 'rgba(164,167,168,.62)' });
    }

    /* 工作点 */
    const devK = push >= 0
      ? (push <= 1 ? Math.pow(220 / 180, push) : Math.pow(220 / 180, 1) * Math.pow(280 / 220, push - 1))
      : Math.pow(150 / 180, -push);
    const px = (GRAY_LX + workEV * 0.30103) * gamma * devK;
    const xx = mapX(clamp(px, x0, x1));
    CV.vline(g, xx, box.y0, box.y1, 'rgba(230,163,61,.55)');
    const D = eng0.filmDensity([0.18, 0.18, 0.18], { EV: workEV, gamma, push });
    for (let m = 0; m < 3; m++) {
      CV.dot(g, xx, mapY(D[m]), 4, cols[m], 'rgba(10,11,12,.8)');
    }
    $('#devReadout').textContent = `D = ${D.map(v => v.toFixed(2)).join(' / ')}`;

    /* 区域标注：贴在曲线实际位置 */
    CV.label(g, 'TOE', box.x0 + 10, box.y1 - 12, { size: 8.5, color: 'rgba(164,167,168,.55)' });
    CV.label(g, '趾部', box.x0 + 10, box.y1 - 24, { size: 8, color: 'rgba(164,167,168,.35)' });
    CV.label(g, 'SHOULDER', box.x1 - 10, box.y0 + 12, { size: 8.5, color: 'rgba(164,167,168,.55)', align: 'right' });
    CV.label(g, '肩部', box.x1 - 10, box.y0 + 24, { size: 8, color: 'rgba(164,167,168,.35)', align: 'right' });

    /* 轴标 */
    CV.label(g, 'log₁₀ 曝光', box.x1, box.y1 + 26, { align: 'right', size: 9 });
    CV.label(g, '−3', box.x0, box.y1 + 26, { align: 'left', size: 8.5 });
    CV.label(g, '+4', box.x1 - 34, box.y1 + 26, { align: 'right', size: 8.5 });
    CV.label(g, '密度 D', box.x0 - 30, box.y0 + 2, { align: 'left', size: 9 });
    CV.label(g, '0', box.x0 - 8, box.y1, { align: 'right', size: 8.5 });
    CV.label(g, '2.5', box.x0 - 8, mapY(2.5) , { align: 'right', size: 8.5 });

    /* 右侧通道标签 */
    cols.forEach((c, m) => {
      CV.label(g, names[m], box.x1 + 14, box.y0 + 16 + m * 16, { color: c, size: 10.5 });
    });
    if (Math.abs(push) > 0.01) {
      CV.label(g, `PUSH ${push > 0 ? '+' : ''}${push.toFixed(1)}`, box.x1 + 12, box.y0 + 68,
        { color: '#e6a33d', size: 9 });
    }
  }

  addEventListener('resize', draw);
  draw();

  const eng = () => SP.build(SP.FILMS[S.film], SP.PAPERS[S.paper], S.latitude);

  /* 三联图：同一张图，不同 push */
  /* 三联图是参考图，不是主反馈。复用 DOM，且拖动停下后再更新 */
  let stripTimer = 0;
  function buildStripDOM(span) {
    const host = $('#devStrip'); if (!host) return;
    host.innerHTML = span.map((p, i) => `
      <div>
        <canvas class="devthumb" data-push="${p}" style="width:100%;border-radius:8px;border:1px solid var(--line);display:block"></canvas>
        <div class="devthumb-cap" style="font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:${i === 1 ? 'var(--safelight)' : 'var(--ink-3)'};margin-top:7px;text-align:center">
          PUSH ${p > 0 ? '+' + p : p}${i === 1 ? ' ◂' : ''}
        </div>
      </div>`).join('');
  }

  function drawStripNow() {
    /* 三格围绕当前 Push 值展开，这样拖动滑块时预览会跟着动，
       能直观看到「推得更多会怎样」。停在 0 时就是经典的 -1 / 0 / +1。 */
    const cur = S.pushVal || 0;
    const span = [-1, 0, 1].map(o => clamp(+(cur + o).toFixed(1), -2, 2));

    buildStripDOM(span);
    const e = eng();
    $$('.devthumb').forEach((c, i) => {
      const W = 150, H = 94;
      if (c.width !== W) { c.width = W; c.height = H; }
      /* 用全分辨率渲染：150×94 本来就快，且避免 renderSceneFast 的
         降采样状态在三次连续调用间互相干扰 */
      c.getContext('2d').putImageData(renderScene(W, H, e, { pushF: span[i] }), 0, 0);
    });

    $('#devTag').textContent = `Push ${cur > 0 ? '+' : ''}${fmt(cur, 1)}`;
  }

  function drawStrip() {
    clearTimeout(stripTimer);
    stripTimer = setTimeout(drawStripNow, 140);
  }

  S.pushVal = 0;
  S.redrawCurve = draw;
  S.redrawDevStrip = drawStrip;
  /* 曲线区 hover：读取该点的密度 */
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    const box = { x0: 48, x1: r.width - 96 };
    const t = (e.clientX - r.left - box.x0) / (box.x1 - box.x0);
    const film = SP.FILMS[S.film];
    const x0 = film.le[0], x1 = film.le[film.le.length - 1];
    const lx = x0 + t * (x1 - x0);
    const D = [0, 1, 2].map(m => SP.interp(film.le.filter(Boolean), film.d, lx, m));
    const tip = $('#tipCurve');
    tip.classList.add('on');
    tip.style.left = (e.clientX - r.left) + 'px';
    const dTop = Math.max(...D);
    tip.style.top = (r.height - 40 - dTop / (Math.max(...film.d.flat()) * 1.05) * (r.height - 58)) + 'px';
    tip.textContent = `logE ${lx.toFixed(2)} → D ${D.map(v => v.toFixed(2)).join('/')}`;
  });
  cv.addEventListener('pointerleave', () => $('#tipCurve').classList.remove('on'));

  drawStrip();
}

/* --------------------------------------------------------------------------
   6. 印片：光谱透射
   -------------------------------------------------------------------------- */
function initPrint() {
  const cv = $('#cPrint'); if (!cv) return;
  const P = { c: 0, m: 0, y: 0, ev: 0, pf: 0, sh: 0, hi: 0, mode: 0 };

  const eng = () => SP.build(SP.FILMS[S.film], SP.PAPERS[S.paper], S.latitude);

  function draw() {
    const { g, w, h } = CV.setup(cv, 250);
    const box = { x0: 46, y0: 16, x1: w - 16, y1: h - 44 };
    CV.axes(g, box, { nx: 5, ny: 3 });

    const e = eng();
    const film = SP.FILMS[S.film], paper = SP.PAPERS[S.paper];
    const Df = e.filmDensity([0.18, 0.18, 0.18], { EV: 0 });
    const Dspec = e.filmSpec(Df);
    const filt = SP.filterTrans(P.c, e.neutral[1] + P.m, e.neutral[2] + P.y);
    const ENL = SP.WL.map(l => SP.planck(l, 2856));

    const T = Dspec.map(d => Math.pow(10, -d));
    const L = SP.WL.map((l, i) => ENL[i] * filt[i] * T[i]);
    const sensG = SP.WL.map((l, i) => Math.pow(10, paper.sens[i][1]));

    const norm = arr => { const m = Math.max(...arr); return arr.map(v => v / (m || 1)); };
    const Tn = norm(T), Ln = norm(L), Sn = norm(sensG);

    const mapX = l => box.x0 + (l - SP.WL[0]) / (SP.WL[SP.WL.length - 1] - SP.WL[0]) * (box.x1 - box.x0);
    const mapY = v => box.y1 - v * (box.y1 - box.y0);

    CV.spectrumBar(g, box.x0, box.y1 + 8, box.x1 - box.x0, 6, SP.WL);

    CV.area(g, SP.WL.map((l, i) => [l, Ln[i]]), mapX, mapY, box.y1, 'rgba(234,231,224,.06)');
    CV.line(g, SP.WL.map((l, i) => [l, Ln[i]]), mapX, mapY, { color: 'rgba(234,231,224,.55)', width: 1.1 });
    CV.line(g, SP.WL.map((l, i) => [l, Tn[i]]), mapX, mapY, { color: '#4fd0e0', width: 2, glow: 8 });
    CV.line(g, SP.WL.map((l, i) => [l, Sn[i]]), mapX, mapY, { color: "#7bcf92", width: 1.3 });

    CV.label(g, '380', box.x0, box.y1 + 24, { size: 9 });
    CV.label(g, '780 nm', box.x1, box.y1 + 24, { size: 9, align: 'right' });
    CV.label(g, 'rel.', box.x0 - 8, box.y0, { size: 9, align: 'right' });

    /* CMY 条形 */
    const bar = (host, D) => {
      const mx = 2.6;
      host.innerHTML = ['C', 'M', 'Y'].map((n, i) => `
        <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:5px">
          <div style="height:${clamp(D[i] / mx, 0, 1) * 40}px;border-radius:4px 4px 0 0;background:linear-gradient(180deg,${['#4fd0e0', '#e268b8', '#efc84a'][i]},${['#4fd0e0', '#e268b8', '#efc84a'][i]}55);transition:height .25s var(--ease)"></div>
          <div style="font-family:var(--mono);font-size:9px;color:var(--ink-3);text-align:center">${n} ${D[i].toFixed(2)}</div>
        </div>`).join('');
    };

    const Dp = e.printDensity([0.18, 0.18, 0.18], {
      cF: P.c, mF: P.m, yF: P.y, EVp: P.ev, preflash: P.pf, shadow: P.sh, highlight: P.hi
    });
    bar($('#cmyBars'), Df);
    bar($('#cmyBars2'), Dp);

    S.printState = P;
    S.redrawPrint = draw;
  }

  /* affectsSpectrum：这个参数是否改变波长分布。
     只有滤色会。曝光/预闪/塑形作用在相纸曲线映射上，不改变入射光谱，
     所以不该触发光谱图重绘（之前无差别重绘，加上抗锯齿抖动，
     会让人误以为它们在联动）。 */
  const bind = (id, out, key, dec = 0, mul = 1, affectsSpectrum = false) => {
    const s = $(id); if (!s) return;
    const paint = () => {
      P[key] = +s.value * mul;
      const p = (+s.value - +s.min) / (+s.max - +s.min) * 100;
      s.style.setProperty('--p', p + '%');
      $(out).textContent = dec ? (+s.value).toFixed(dec) : Math.round(+s.value);
      if (affectsSpectrum) draw();
      if (S.schedulePrintBA) S.schedulePrintBA(true);
    };
    s.addEventListener('input', paint);
    paint();
  };
  bind('#sC', '#oC', 'c', 0, 1, true);
  bind('#sM', '#oM', 'm', 0, 1, true);
  bind('#sY', '#oY', 'y', 0, 1, true);
  bind('#sPEV', '#oPEV', 'ev', 1);
  bind('#sPF', '#oPF', 'pf', 2);
  bind('#sSh', '#oSh', 'sh', 1);
  bind('#sHi', '#oHi', 'hi', 1);

  $('#btnBal').addEventListener('click', () => {
    /* M/Y 滑块是「相对中性平衡的偏移」，所以归零就是该 Stock×Paper 的标称中性 */
    ['#sC', '#sM', '#sY'].forEach(id => { $(id).value = 0; $(id).dispatchEvent(new Event('input')); });
    draw();
  });

  addEventListener('resize', draw);
  draw();

  /* ---- 印片对比：左边固定中性参考，右边是当前全部印片设置 ---- */
  function drawPrintBA(fast) {
    const cv2 = $('#cPrintImg'); if (!cv2) return;
    const W = 460, H = 210;
    if (cv2.width !== W) { cv2.width = W; cv2.height = H; }
    const ctx = cv2.getContext('2d');

    /* 基准：所有印片参数归零。它必须固定，否则左边也跟着动，对比就没有参照了 */
    const NEUTRAL = { EVp: 0, preflash: 0, shadow: 0, highlight: 0, cF: 0, mF: 0, yF: 0 };
    /* 当前：这一组的全部设置 */
    const CURRENT = { EVp: P.ev, preflash: P.pf, shadow: P.sh, highlight: P.hi, cF: P.c, mF: P.m, yF: P.y };

    const e = eng();
    /* 中性侧永远同一张图，缓存起来；只有当前侧需要重算 */
    if (!S._baNeutral) S._baNeutral = renderScene(W, H, e, NEUTRAL);

    /* 拖动中用低分辨率出图（肉眼在拖动时分辨不出来），松手后补全 */
    const scale = fast ? 0.55 : 1;
    const rw = Math.round(W * scale), rh = Math.round(H * scale);
    /* 签名必须包含扫描状态，否则打开扫描仪后缓存不会失效 */
    const scanSig = S.scanState ? `s${S.scanState.glare},${S.scanState.mtf},${S.scanState.us}` : 'off';
    const sig = JSON.stringify(CURRENT) + '|' + scale + '|' + S.film + S.paper + '|' + scanSig;
    if (S._baSig !== sig) {
      const small = renderScene(rw, rh, e, CURRENT);
      let scaled = (rw === W) ? small : scaleImageData(small, W, H);
      /* 扫描仪作用在最终成片上 —— 这是整条链的最后一站 */
      if (S.scanState && S.scanState.on) S.applyScanner(scaled, S.scanState);
      S._baCurrent = scaled;
      S._baSig = sig;
    }

    if (!S._baOff) {
      S._baOff = document.createElement('canvas'); S._baOff.width = W; S._baOff.height = H;
      S._baOn = document.createElement('canvas'); S._baOn.width = W; S._baOn.height = H;
    }
    S._baOff.getContext('2d').putImageData(S._baNeutral, 0, 0);
    S._baOn.getContext('2d').putImageData(S._baCurrent, 0, 0);
    paintPrintBA();
  }

  /* 只做裁切合成，不做像素运算 —— 拖分割线时走这里 */
  function paintPrintBA() {
    const cv2 = $('#cPrintImg'); if (!cv2 || !S._baOff) return;
    const W = cv2.width, H = cv2.height;
    const ctx = cv2.getContext('2d');
    const sx = Math.round(W * (S.printSplit || 0.5));
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(S._baOff, 0, 0, sx, H, 0, 0, sx, H);
    ctx.drawImage(S._baOn, sx, 0, W - sx, H, sx, 0, W - sx, H);
    $('#printHandle').style.left = ((S.printSplit || 0.5) * 100) + '%';
  }

  const pba = $('#printBA');
  if (pba) {
    const dragP = e => {
      const r = pba.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      S.printSplit = clamp(x / r.width, 0.02, 0.98);
      paintPrintBA();              /* 拖动只重绘 */
    };
    pba.addEventListener('pointerdown', e => {
      pba.setPointerCapture(e.pointerId);
      dragP(e);
      const mv = ev => dragP(ev);
      const up = () => { pba.removeEventListener('pointermove', mv); pba.removeEventListener('pointerup', up); };
      pba.addEventListener('pointermove', mv);
      pba.addEventListener('pointerup', up);
    });
  }
  /* 拖动时先画低分辨率快速版，停下 120ms 后再补全质量 */
  let baTimer = 0;
  const scheduleBA = (fast) => {
    if (fast) {
      drawPrintBA(true);
      clearTimeout(baTimer);
      baTimer = setTimeout(() => drawPrintBA(false), 130);
    } else {
      drawPrintBA(false);
    }
  };
  S.redrawPrintBA = () => scheduleBA(false);
  S.schedulePrintBA = scheduleBA;
  drawPrintBA(false);
  const modeSeg = $('#printModeSeg');
  if (modeSeg) {
    modeSeg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#printModeSeg button').forEach(x => x.classList.toggle('on', x === b));
      P.mode = +b.dataset.m;
      if (P.mode === 1) {
        $('#oC').textContent = '—'; $('#oM').textContent = '—'; $('#oY').textContent = '—';
      } else {
        $('#oC').textContent = Math.round(P.c);
        $('#oM').textContent = Math.round(P.m);
        $('#oY').textContent = Math.round(P.y);
      }
      draw();
    });
  }
}

/* --------------------------------------------------------------------------
   7. 纹理实验室
   -------------------------------------------------------------------------- */
let texBase = null, texOn = null, texOff = null;

function initTexture() {
  const cv = $('#cTex'); if (!cv) return;
  const wrap = $('#baWrap');

  /* 把两张图分开：只有参数变化才重算，拖动分割线只重绘 */
  let layers = null;   // { rw, rh, off, on }

  /* 底图与 film/paper 绑定，参数变化才重算 */
  function baseImage(rw, rh) {
    const key = rw + 'x' + rh + '|' + S.film + '|' + S.paper + '|' + (S.filmParams ? JSON.stringify(S.filmParams) : '');
    if (!S._texBaseImg || S._texBaseKey !== key) {
      const eng = SP.build(SP.FILMS[S.film], SP.PAPERS[S.paper], S.latitude);
      S._texBaseImg = renderScene(rw, rh, eng, {});
      S._texBaseKey = key;
    }
    return S._texBaseImg;
  }

  /* 拖动中用低分辨率跑纹理，停下后补全质量 */
  let texTimer = 0;

  function recompute(quality) {
    const W = Math.min(520, Math.max(320, wrap.clientWidth));
    const H = Math.round(W * 0.56);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const fast = quality !== 'full';
    const s = fast ? 0.5 : 1;

    const rw = Math.round(W * dpr * s);
    const rh = Math.round(H * dpr * s);

    const base = baseImage(rw, rh);
    const textured = applyTexture(base, S.texMode, S.texAmount, S.texScale);

    cv.width = rw; cv.height = rh;
    cv.style.width = '100%';
    cv.style.height = 'auto';

    if (!layers || layers.rw !== rw || layers.rh !== rh) {
      const off = document.createElement('canvas'); off.width = rw; off.height = rh;
      const on = document.createElement('canvas'); on.width = rw; on.height = rh;
      layers = { rw, rh, off, on };
    }
    layers.off.getContext('2d').putImageData(base, 0, 0);
    layers.on.getContext('2d').putImageData(textured, 0, 0);
    paint();

    /* 快速版画完后安排一次全质量 */
    clearTimeout(texTimer);
    if (fast) texTimer = setTimeout(() => recompute('full'), 160);
  }

  /* 纯合成：两张 canvas 按分割位置裁切，没有像素运算 */
  function paint() {
    if (!layers) return;
    const { rw, rh, off, on } = layers;
    const g = cv.getContext('2d');
    const sx = Math.round(rw * S.split);
    g.clearRect(0, 0, rw, rh);
    g.drawImage(off, 0, 0, sx, rh, 0, 0, sx, rh);
    g.drawImage(on, sx, 0, rw - sx, rh, sx, 0, rw - sx, rh);
    $('#baHandle').style.left = (S.split * 100) + '%';
  }

  function drag(e) {
    const r = wrap.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    S.split = clamp(x / r.width, 0.02, 0.98);
    paint();                       /* 拖动只重绘，不重算 */
  }
  wrap.addEventListener('pointerdown', e => {
    wrap.setPointerCapture(e.pointerId);
    drag(e);
    const move = ev => drag(ev);
    const up = () => { wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up); };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
  });

  $('#texSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#texSeg button').forEach(x => x.classList.toggle('on', x === b));
    S.texMode = b.dataset.t;
    $('#baTagOn').textContent = { grain: 'GRAIN ON', halation: 'HALATION ON', diffusion: 'DIFFUSION ON', all: 'ALL ON' }[S.texMode];
    const lbl = { grain: ['Amount', 'Scale'], halation: ['Halation Amount', 'Radius Scale'], diffusion: ['Strength', 'Radius Scale'], all: ['Amount', 'Scale'] }[S.texMode];
    $('#texLblA').textContent = lbl[0]; $('#texLblB').textContent = lbl[1];
    recompute();
  });

  const sa = $('#sTexA'), sb = $('#sTexB');
  const onA = () => {
    S.texAmount = +sa.value;
    sa.style.setProperty('--p', ((+sa.value) / 1 * 100) + '%');
    $('#oTexA').textContent = fmt(S.texAmount, 2);
    if (S.texMode === 'halation') S.hal = 0.4 + S.texAmount * 1.6;
    if (S.texMode === 'diffusion') S.diff = S.texAmount;
    recompute();
  };
  const onB = () => {
    S.texScale = +sb.value;
    sb.style.setProperty('--p', ((+sb.value - 0.2) / 2.8 * 100) + '%');
    $('#oTexB').textContent = fmt(S.texScale, 2);
    recompute();
  };
  sa.addEventListener('input', onA); sb.addEventListener('input', onB);
  onA(); onB();

  /* 卤化 & 扩散 小图 */
  const drawHal = () => {
    const c = $('#cHal'); if (!c) return;
    const { g, w, h } = CV.setup(c, 120);
    g.fillStyle = '#0a0b0c'; g.fillRect(0, 0, w, h);
    const cx = w * 0.44, cy = h * 0.5;
    const rad = 9;
    const amt = S.hal;
    for (let i = 6; i >= 1; i--) {
      const rr = rad + i * 5.2 * (0.6 + amt);
      const a = Math.pow(1 - i / 7, 2.1) * 0.34 * amt;
      g.beginPath(); g.arc(cx, cy, rr, 0, 7);
      g.fillStyle = `rgba(236,90,69,${a * 0.55})`;
      g.fill();
    }
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad * 1.6);
    grd.addColorStop(0, '#fff'); grd.addColorStop(0.55, '#ffe9cf'); grd.addColorStop(1, 'rgba(255,220,180,0)');
    g.beginPath(); g.arc(cx, cy, rad * 1.6, 0, 7); g.fillStyle = grd; g.fill();
    CV.label(g, 'back-reflection', w - 10, h - 12, { align: 'right', size: 8.5, color: 'rgba(164,167,168,.5)' });
  };
  const drawDiff = () => {
    const c = $('#cDiff'); if (!c) return;
    const { g, w, h } = CV.setup(c, 120);
    g.fillStyle = '#0a0b0c'; g.fillRect(0, 0, w, h);
    const cx = w * 0.44, cy = h * 0.5;
    const rad = 9;
    const amt = S.diff;
    for (let i = 6; i >= 1; i--) {
      const rr = rad + i * 6.4 * (0.5 + amt);
      const a = Math.pow(1 - i / 7, 2.0) * 0.30 * amt;
      g.beginPath(); g.arc(cx, cy, rr, 0, 7);
      g.fillStyle = `rgba(255,255,255,${a})`;
      g.fill();
    }
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad * 1.9);
    grd.addColorStop(0, '#fff'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.beginPath(); g.arc(cx, cy, rad * 1.9, 0, 7); g.fillStyle = grd; g.fill();
    CV.label(g, 'PSF · core + halo + bloom', w - 10, h - 12, { align: 'right', size: 8.5, color: 'rgba(164,167,168,.5)' });
  };
  $('#sHal').addEventListener('input', e => {
    const v = +e.target.value; S.hal = v;
    e.target.style.setProperty('--p', v / 2 * 100 + '%');
    $('#oHal').textContent = fmt(v, 2); drawHal(); recompute();
  });
  $('#sDiff').addEventListener('input', e => {
    const v = +e.target.value; S.diff = v;
    e.target.style.setProperty('--p', v / 2 * 100 + '%');
    $('#oDiff').textContent = fmt(v, 2); drawDiff(); recompute();
  });
  $('#sHal').style.setProperty('--p', '50%');
  $('#sDiff').style.setProperty('--p', '25%');
  drawHal(); drawDiff();
  addEventListener('resize', () => { drawHal(); drawDiff(); recompute(); });
  recompute();
}

/* --------------------------------------------------------------------------
   8. 扫描
   -------------------------------------------------------------------------- */
function initScan() {
  const cv = $('#cScan'); if (!cv) return;
  const st = { on: false, glare: 3, mtf: 60, us: 0.7 };

  /* ---- 扫描仪的实际图像处理 ----
     MTF50 → 高斯 σ（与插件一致：1000·sqrt(ln2/2π²)/MTF50）
     Glare → 均匀抬黑 + 轻微提亮（扫描光在印片表面反射回来的污染）
     USM   → 反遮罩锐化，补回 MTF 丢掉的细节
     这三步顺序和真实扫描仪一致：先光学模糊，再眩光污染，最后锐化。 */
  /* MTF50 → 高斯 σ。真实换算是 1000·sqrt(ln2/2π²)/MTF50 微米。
     但 150px 缩略图若对应整个 24mm 片窗，每像素 160µm，远粗于几微米的光斑 ——
     MTF 在小图上物理上就该看不见。所以这里把预览定义为「片窗局部放大」：
     150px 对应 2mm，相当于扫描仪凑近看胶片的倍率，σ 才落在可辨认的像素尺度上。 */
  const PREVIEW_MM = 2;
  const mtfSigmaPx = (mtf50, W) => {
    if (!(mtf50 > 0)) return 0;
    const sigmaUm = 1000 * Math.sqrt(Math.LN2 / (2 * Math.PI * Math.PI)) / mtf50;
    return sigmaUm * (W / (PREVIEW_MM * 1000));
  };

  function boxBlur3(src, w, h, R) {
    if (R < 1) return src;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const inv = 1 / (2 * R + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let k = -R; k <= R; k++) s += src[row + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s * inv;
        s += src[row + clamp(x + R + 1, 0, w - 1)] - src[row + clamp(x - R, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s * inv;
        s += tmp[clamp(y + R + 1, 0, h - 1) * w + x] - tmp[clamp(y - R, 0, h - 1) * w + x];
      }
    }
    return out;
  }

  function applyScanner(img, o) {
    if (!o.on) return img;
    const w = img.width, h = img.height, d = img.data;

    /* 1) 光学模糊：MTF50 越低越糊 */
    const sigma = mtfSigmaPx(o.mtf, w);
    if (sigma > 0.35) {
      const R = Math.min(24, Math.max(1, Math.round(sigma * 1.5)));
      const ch = [0, 1, 2].map(c => {
        const a = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + c];
        return boxBlur3(a, w, h, R);
      });
      for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) d[i * 4 + c] = ch[c][i];
    }

    /* 2) 眩光：均匀抬黑，蓝端略多（扫描光源偏冷） */
    const gl = o.glare / 100;
    if (gl > 0) {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp(d[i] + gl * 255 * 0.90, 0, 255);
        d[i + 1] = clamp(d[i + 1] + gl * 255 * 0.94, 0, 255);
        d[i + 2] = clamp(d[i + 2] + gl * 255 * 1.00, 0, 255);
      }
    }

    /* 3) USM：用模糊版当遮罩，把差值加回去 */
    if (o.us > 0) {
      const R = Math.max(1, Math.round(Math.max(1, sigma) * 2));
      for (let c = 0; c < 3; c++) {
        const a = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + c];
        const b = boxBlur3(a, w, h, R);
        for (let i = 0; i < w * h; i++) d[i * 4 + c] = clamp(a[i] + (a[i] - b[i]) * o.us, 0, 255);
      }
    }
    return img;
  }
  S.applyScanner = applyScanner;

  function draw() {
    const { g, w, h } = CV.setup(cv, 210);
    const box = { x0: 44, y0: 14, x1: w - 14, y1: h - 30 };
    CV.axes(g, box, { nx: 5, ny: 3 });

    const eng = SP.build(SP.FILMS[S.film], SP.PAPERS[S.paper], S.latitude);
    const paper = SP.PAPERS[S.paper];
    const Dp = eng.printDensity([0.18, 0.18, 0.18]);

    /* 扫描光 × 透过率 */
    const I = SP.WL.map(l => SP.planck(l, 5000));
    const tr = SP.WL.map((l, i) => Math.exp(-(paper.base[i] + Dp[0] * paper.dye[i][0] + Dp[1] * paper.dye[i][1] + Dp[2] * paper.dye[i][2]) * Math.LN10));
    const L = I.map((v, i) => v * tr[i]);
    const mx = Math.max(...L);

    const mapX = l => box.x0 + (l - SP.WL[0]) / (SP.WL[SP.WL.length - 1] - SP.WL[0]) * (box.x1 - box.x0);
    const mapY = v => box.y1 - v * (box.y1 - box.y0);

    CV.spectrumBar(g, box.x0, box.y1 + 6, box.x1 - box.x0, 6, SP.WL);
    CV.area(g, SP.WL.map((l, i) => [l, L[i] / mx]), mapX, mapY, box.y1, 'rgba(255,255,255,.08)');
    CV.line(g, SP.WL.map((l, i) => [l, L[i] / mx]), mapX, mapY, { color: 'rgba(255,255,255,.7)', width: 1.7, glow: 6 });

    /* 三条 CIE 曲线 */
    const cols = ['#ef5b4b', '#7bcf92', '#4d8df0'];
    for (let k = 0; k < 3; k++) {
      const cc = SP.CM.map(c => c[k]);
      const mm = Math.max(...cc);
      CV.line(g, SP.WL.map((l, i) => [l, cc[i] / mm]), mapX, mapY, { color: cols[k], width: 1.1 });
    }
    CV.label(g, '扫描光 × 透过率', box.x0 + 4, box.y0 + 10, { size: 8.5, color: 'rgba(164,167,168,.55)' });
    CV.label(g, 'x̄ ȳ z̄', box.x1 - 4, box.y0 + 10, { size: 8.5, color: 'rgba(164,167,168,.55)', align: 'right' });

    /* 三联：基准 / 当前设置 / 极端对照 */
    const host = $('#scanStrip');
    if (!host.dataset.built) {
      host.innerHTML = ['原始', '当前设置', '光晕 + 低解析力'].map((t, i) => `
        <div>
          <canvas class="scanthumb" data-i="${i}" style="width:100%;border-radius:8px;border:1px solid var(--line);display:block"></canvas>
          <div class="scan-cap" data-i="${i}" style="font-family:var(--mono);font-size:9px;letter-spacing:.08em;color:var(--ink-3);margin-top:6px;text-align:center"></div>
        </div>`).join('');
      host.dataset.built = '1';
    }

    const base = renderScene(150, 94, eng, {});
    /* 第二格预览「当前参数」；第三格作为对照锚点，故意拉到很极端，
       免得用户以为滑块没反应 */
    const cur = { on: true, glare: st.glare, mtf: st.mtf, us: st.us };
    const extreme = { on: true, glare: 18, mtf: 8, us: 2.4 };

    [[base, null], [base, cur], [base, extreme]].forEach(([src, cfg], i) => {
      const c = host.querySelector(`.scanthumb[data-i="${i}"]`);
      if (!c) return;
      c.width = 150; c.height = 94;
      const copy = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
      if (cfg) applyScanner(copy, cfg);
      c.getContext('2d').putImageData(copy, 0, 0);

      const cap = host.querySelector(`.scan-cap[data-i="${i}"]`);
      if (cap) {
        cap.textContent = i === 0 ? '原始'
          : i === 1 ? `${st.on ? '' : '未启用 · '}眩光 ${st.glare}% / ${st.mtf}lp`
          : '极端 · 18% / 8lp';
      }
    });

    $('#scanTag').textContent = 'Scanner ' + (st.on ? 'ON' : 'OFF');
    $('#scanTag').style.color = st.on ? 'var(--safelight)' : '';
    /* 参数变化会影响其它区块的成片，通知一次 */
    S.scanState = st.on ? { on: true, glare: st.glare, mtf: st.mtf, us: st.us } : null;
    if (S.redrawPrintBA) S.redrawPrintBA();
  }

  $('#tScan').addEventListener('change', e => {
    st.on = e.target.checked;
    $('#scanTag').style.color = st.on ? 'var(--safelight)' : '';
    draw();
  });
  const mk = (id, out, key, dec) => {
    const s = $(id); if (!s) return;
    const f = () => {
      const v = +s.value;
      st[key] = v;
      s.style.setProperty('--p', ((v - +s.min) / (+s.max - +s.min) * 100) + '%');
      $(out).textContent = dec ? v.toFixed(dec) : Math.round(v);
      draw();
    };
    s.addEventListener('input', f); f();
  };
  mk('#sGl', '#oGl', 'glare', 0);
  mk('#sMtf', '#oMtf', 'mtf', 0);
  mk('#sUs', '#oUs', 'us', 2);

  addEventListener('resize', draw);
  draw();
}

/* --------------------------------------------------------------------------
   9. 角色 / 方法 / 颗粒模型 文案
   -------------------------------------------------------------------------- */
const TEXT = {
  method: [
    {
      t: 'Hanatos 2026',
      d: '当前默认。把 RGB 看成色度 + 亮度，在<b>可见光轨迹</b>上取一条平滑光谱，再用亮度还原强度。宽色域素材、超出 sRGB 的饱和色都表现稳定。插件把整张二维 LUT 预计算在 GPU 纹理里，运行时只做一次双三次采样。'
    },
    {
      t: 'Hanatos 2025',
      d: '同一思路的上一版实现，带一个「适配窗」来约束光谱形状。多数素材与 2026 版几乎一致，少数高饱和场景会略有差异。为兼容旧工程保留。'
    },
    {
      t: 'Mallett 2019',
      d: '把 RGB 直接当作三条<b>光谱基函数</b>的权重，重建一条类反射率光谱，再乘参考光源。极快、实现简洁，但对输入色域更敏感：超出基函数覆盖范围的色彩会偏。'
    }
  ],
  grainModel: [
    { t: 'Preview', d: '最快的近似：直接用高斯统计生成密度扰动，不做分层与染料云模糊。适合调参阶段预览手感，最终渲染前建议切到 Production。' },
    { t: 'Production', d: '完整模型：按乳剂深度分成多层，每层独立数粒子，再叠加染料云模糊与微观结构。速度中等，是交付级质量的默认选择。' },
    { t: 'Grain Synthesis', d: '最物理：在胶片平面坐标里定义一个随机的布尔颗粒场，用蒙特卡洛采样估计像素覆盖率，再把覆盖率换成光学密度。非常慢，颗粒形态最接近真实胶片。官方标注仍是<b>开发中</b>，不建议用于正式交付。' }
  ],
  role: [
    { t: 'Display SDR', d: '插件就是最后一环：做完 SDR 显示变换后直接输出。此时<b>不应该</b>再在 Resolve 里加 CST 或输出 LUT，否则会二次变换。' },
    { t: 'Display HDR', d: '同上，但输出 PQ 或 HLG。注意 Reference White 与 Peak Nits 的配合，以及 HDR Tone Mapping 的选择。' },
    { t: 'RCM/ACES', d: '插件输出<b>场景参考</b>的线性值（DaVinci Intermediate WideGamut 等），把显示变换交回 Resolve。适合需要下游继续调色、或多交付版本的项目。' }
  ]
};

function initSegTexts() {
  const wire = (segId, bodyId, arr) => {
    const seg = $(segId), body = $(bodyId);
    if (!seg || !body) return;
    const show = i => {
      body.style.opacity = 0;
      setTimeout(() => {
        body.innerHTML = `<div class="role-name">${arr[i].t}</div><div>${arr[i].d}</div>`;
        body.style.transition = 'opacity .35s var(--ease)';
        body.style.opacity = 1;
      }, 90);
    };
    seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $$(segId + ' button').forEach(x => x.classList.toggle('on', x === b));
      show(Array.from(seg.children).indexOf(b));
    });
    show(0);
  };
  wire('#methodSeg', '#methodBody', TEXT.method);
  wire('#grainModelSeg', '#grainModelBody', TEXT.grainModel);
  wire('#roleSeg', '#roleBody', TEXT.role);

  /* 画幅 */
  const fmts = [
    { f: 0, n: '8mm', mm: 4.8, d: '极小画幅。同样一块颗粒占画面的比例最大，所以颗粒最粗、光晕最宽。' },
    { f: 2, n: '16mm', mm: 10.26, d: '16mm 的颗粒感是"有质感但不脏"。很多复古风格会选这里。' },
    { f: 4, n: '35mm', mm: 35.0, d: '行业标准。颗粒细而不失结构，是最安全的起点。' },
    { f: 7, n: '65/70mm', mm: 70.41, d: '大画幅。同样的输出分辨率采样了更大的物理面积，颗粒极细、细节极多。' }
  ];
  const seg = $('#fmtSeg'), note = $('#fmtNote');
  if (seg && note) {
    const show = f => {
      const o = fmts.find(x => x.f === f);
      note.textContent = `长边 ${o.mm.toFixed(2)} mm · ${o.d}`;
    };
    seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#fmtSeg button').forEach(x => x.classList.toggle('on', x === b));
      show(+b.dataset.f);
      S.fmt = +b.dataset.f;
    });
    show(4);
  }
}

/* --------------------------------------------------------------------------
   10. 节点树
   -------------------------------------------------------------------------- */
function initNodes() {
  const host = $('#nodeFlow'); if (!host) return;
  const nodes = [
    { t: 'Source', s: '媒体', c: '#6b6f76' },
    { t: 'CST / Input', s: '技术转换', c: '#8a8f96' },
    { t: 'Balance', s: '镜头平衡', c: '#8a8f96' },
    { t: 'Windows', s: '局部修正', c: '#8a8f96' },
    { t: 'spektrafilm', s: '胶片 + 印片 + 扫描', c: '#e6a33d', hi: true },
    { t: 'Output', s: '交付', c: '#6b6f76' }
  ];
  host.innerHTML = `<div style="display:flex;align-items:stretch;gap:0;overflow-x:auto;padding-bottom:6px">` +
    nodes.map((n, i) => `
      <div style="display:flex;align-items:center;flex:0 0 auto">
        <div style="min-width:${n.hi ? 148 : 104}px;padding:${n.hi ? '16px 14px' : '12px 12px'};border-radius:10px;
          border:1px solid ${n.hi ? 'rgba(230,163,61,.45)' : 'var(--line)'};
          background:${n.hi ? 'rgba(230,163,61,.10)' : 'rgba(255,255,255,.02)'};
          ${n.hi ? 'box-shadow:0 0 30px rgba(230,163,61,.10)' : ''}">
          <div style="font-family:var(--mono);font-size:${n.hi ? '11px' : '10px'};letter-spacing:.06em;color:${n.hi ? 'var(--safelight-2)' : 'var(--ink-2)'}">${n.t}</div>
          <div style="font-size:10.5px;color:var(--ink-4);margin-top:5px">${n.s}</div>
        </div>
        ${i < nodes.length - 1 ? `<div style="width:${n.hi ? 30 : 22}px;height:1px;background:${n.hi || nodes[i + 1].hi ? 'rgba(230,163,61,.5)' : 'var(--line-2)'};position:relative;flex:0 0 auto">
          <span style="position:absolute;right:-1px;top:-3px;width:5px;height:5px;border-right:1px solid ${n.hi || nodes[i + 1].hi ? 'rgba(230,163,61,.5)' : 'var(--line-2)'};border-top:1px solid ${n.hi || nodes[i + 1].hi ? 'rgba(230,163,61,.5)' : 'var(--line-2)'};transform:rotate(45deg)"></span>
        </div>` : ''}
      </div>`).join('') + `</div>`;

  const notes = [
    { h: '插件之前', b: '做技术转换（LogC4 → 线性 / 宽色域）、镜头之间的曝光与白平衡匹配、以及那些「应该在进胶片之前」的局部窗口修正。' },
    { h: '插件本身', b: '一次走完曝光 → 显影 → 印片 → 颗粒 → 扫描。把它当成一台机器，而不是一串滤镜。' },
    { h: '插件之后', b: '只有当你选了 <b>RCM/ACES</b> 时，才在这里做显示变换或继续调色。选 SDR/HDR 时，这里应该只有交付。' }
  ];
  $('#nodeNotes').innerHTML = notes.map(n => `
    <div style="padding:14px 16px;border-radius:10px;background:rgba(255,255,255,.022);border:1px solid var(--line)">
      <div class="card-t" style="margin-bottom:8px">${n.h}</div>
      <p style="font-size:13px;color:var(--ink-2);line-height:1.7">${n.b}</p>
    </div>`).join('');

  $('#routeList').innerHTML = ROUTES.map(r => `
    <div class="route">
      <div class="route-goal">${r.goal}</div>
      <div class="route-where">${r.where}</div>
      <p class="route-why">${r.why}</p>
    </div>`).join('');
}

/* --------------------------------------------------------------------------
   11. 参数索引
   -------------------------------------------------------------------------- */
function initParams() {
  const host = $('#pIndex'); if (!host) return;

  host.innerHTML = PARAM_GROUPS.map((g, gi) => `
    <div class="pgroup" data-g="${gi}">
      <div class="pgroup-h">
        <span class="ic">${String(gi + 1).padStart(2, '0')}</span>
        <span class="nm">${g.zh} <span style="color:var(--ink-4);font-size:11.5px;font-family:var(--mono);letter-spacing:.08em;margin-left:8px">${g.name}</span></span>
        <span class="ct">${g.params.length}</span>
        <span class="ar">▸</span>
      </div>
      <div class="pgroup-b">
        ${g.params.map(p => `
          <div class="prow" data-k="${(p.k + ' ' + p.n + ' ' + p.d).toLowerCase()}">
            <div class="pn"><b>${p.n}</b><i>${p.r}</i></div>
            <div class="pd">${p.d}</div>
          </div>`).join('')}
      </div>
    </div>`).join('');

  /* 先展开第一组作为示例 */
  host.querySelector('.pgroup').classList.add('open');

  host.addEventListener('click', e => {
    const h = e.target.closest('.pgroup-h');
    if (h) h.parentElement.classList.toggle('open');
  });

  const total = PARAM_GROUPS.reduce((a, g) => a + g.params.length, 0);
  $('#pCount').textContent = total + ' 项';

  $('#pSearch').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $$('.pgroup').forEach(g => {
      let any = false;
      g.querySelectorAll('.prow').forEach(r => {
        const hit = !q || r.dataset.k.includes(q);
        r.style.display = hit ? '' : 'none';
        if (hit) any = true;
      });
      g.style.display = any ? '' : 'none';
      if (q && any) g.classList.add('open');
    });
  });

  let all = false;
  $('#pExpand').addEventListener('click', () => {
    all = !all;
    $$('.pgroup').forEach(g => g.classList.toggle('open', all));
    $('#pExpand').textContent = all ? '全部收起' : '全部展开';
  });
}

/* --------------------------------------------------------------------------
   11b. 手感实验室
   -------------------------------------------------------------------------- */
const LAB = [
  {
    id: 'fe', seg: 'Film EV', grp: 'FILM · 曝光', name: 'Film Exposure EV',
    min: -2, max: 2, step: .1, val: 0, unit: ' EV',
    desc: '改变底片接收到的光量，决定场景落在特性曲线的哪一段。所以它影响的不只是亮度，还有反差、颗粒和卤化的手感。',
    hint: '等同于降 ISO 拍摄。+1 会让暗部更早离开趾部，但也更快撞进肩部。',
    apply: v => ({ EVf: v })
  },
  {
    id: 'pe', seg: 'Print EV', grp: 'PRINT · 曝光', name: 'Print Exposure EV',
    min: -1.2, max: 1.2, step: .05, val: 0,
    desc: '放大机曝光。负片已经定死了，这里只改"印多亮"。它不会改变底片的颗粒结构与曲线落点。',
    hint: '底片正确、只是整体偏暗或偏亮时用它。要改反差请去 Film Push 或 Print Push。',
    apply: v => ({ EVp: v })
  },
  {
    id: 'pf', seg: 'Push', grp: 'FILM · 显影', name: 'Push / Pull Stops',
    min: -2, max: 2, step: .1, val: 0,
    desc: '推/拉显影。用真实的 ECN-2 显影时间比例改变反差与有效感光度。正数推：更硬、暗部更早起来。',
    hint: '推得越多，亮部越早压进肩部。push 之后高光糊成一片，原因就在这里。',
    apply: v => ({ pushF: v })
  },
  {
    id: 'c', seg: 'C Filter', grp: 'PRINT · 滤色', name: 'C Filter',
    min: -60, max: 60, step: 1, val: 0,
    desc: '青色滤片量。它挡红光，相纸红层因此欠曝。因为负片是反的，最终画面会偏暖。',
    hint: '记住方向：滤片挡什么，画面就偏什么。这和 RGB 的加减色是反过来的。',
    apply: v => ({ cF: v })
  },
  {
    id: 'm', seg: 'M Filter', grp: 'PRINT · 滤色', name: 'M Filter Shift',
    min: -60, max: 60, step: 1, val: 0,
    desc: '品红滤片偏移。它挡绿光，绿层欠曝，所以画面偏绿。',
    hint: '配合 C 与 Y 使用。三者组合就是暗房里的"减色法"配色。',
    apply: v => ({ mF: v })
  },
  {
    id: 'y', seg: 'Y Filter', grp: 'PRINT · 滤色', name: 'Y Filter Shift',
    min: -60, max: 60, step: 1, val: 0,
    desc: '黄色滤片偏移。它挡蓝光，蓝层欠曝，所以画面偏蓝。',
    hint: '想整体偏冷就加 Y；想偏暖就加 C。两者是同一套反相逻辑。',
    apply: v => ({ yF: v })
  },
  {
    id: 'pp', seg: 'Printer Pt', grp: 'PRINT · 配光', name: 'Printer Points (R)',
    min: -24, max: 24, step: 1, val: 0,
    desc: '配光点，单位 1/12 档。数值变大 = 红通道印片曝光变多。这是好莱坞配光表的语言。',
    hint: '和滤色的关系：一点 = 1/12 档。Printer Density 模式里三通道一起推就是整体明暗。',
    apply: v => ({ pR: v })
  },
  {
    id: 'sh', seg: 'Shadow', grp: 'PRINT · 塑形', name: 'Shadow Shape',
    min: -1, max: 1, step: .05, val: 0,
    desc: '通过相纸响应塑造暗部。正值"打开"暗部，同时保持纸黑与纸白两个端点不动。',
    hint: '和 Preflash 的区别：Preflash 是真实的额外曝光，Shadow Shape 是纯曲线塑形。',
    apply: v => ({ shadow: v })
  },
  {
    id: 'hi', seg: 'Highlight', grp: 'PRINT · 塑形', name: 'Highlight Shape',
    min: -1, max: 1, step: .05, val: 0,
    desc: '塑造亮部。负值让高光更柔和、肩部更收，纸白仍然保留。',
    hint: '想要"高光有余量"的感觉就调负值。它不会让画面变暗，只会让过渡更长。',
    apply: v => ({ highlight: v })
  },
  {
    id: 'gam', seg: 'Gamma', grp: 'FILM · 曲线', name: 'Film Gamma',
    min: .6, max: 1.5, step: .01, val: 1,
    desc: '特性曲线斜率缩放。这是"直接改反差"，不像 Push 那样还带动感光度。',
    hint: '比 Push 更"干净"：它只动斜率。想做实验性效果时用它。',
    apply: v => ({ gammaF: v })
  },
  {
    id: 'pre', seg: 'Preflash', grp: 'PRINT · 预闪', name: 'Preflash Exposure',
    min: 0, max: .55, step: .01, val: 0,
    desc: '在影像曝光之前给相纸一次均匀弱曝光。相纸的趾部在高光端，所以它主要撑开高光层次、柔化纯白。',
    hint: '盯住纯白区和亮部渐变，那里的层次会变多。注意它也会轻微提亮整幅画面。',
    apply: v => ({ preflash: v })
  }
];

function initLab() {
  const seg = $('#labSeg'), cv = $('#cLab'), wrap = $('#labBA');
  if (!seg || !cv) return;

  seg.innerHTML = LAB.map((l, i) =>
    `<button data-i="${i}" class="${i === 0 ? 'on' : ''}">${l.seg}</button>`).join('');

  let cur = LAB[0];
  let labTimer = 0;
  const W = 470, H = 250;
  cv.width = W; cv.height = H;

  function rebuild(fast) {
    const e = SP.build(SP.FILMS[S.film], SP.PAPERS[S.paper], S.latitude);
    const baseOpts = { EVf: S.filmParams?.ev || 0, gammaF: S.filmParams?.gamma || 1, pushF: S.filmParams?.push || 0 };

    /* 基准侧缓存：只要 baseOpts 没变就复用 */
    const bkey = JSON.stringify(baseOpts);
    if (!S._labBase || S._labBaseKey !== bkey) {
      S._labBase = renderScene(W, H, e, baseOpts);
      S._labBaseKey = bkey;
    }
    const base = S._labBase;

    /* 拖动中降分辨率，松手补全 */
    const s = fast ? 0.55 : 1;
    const rw = Math.round(W * s), rh = Math.round(H * s);
    const modRaw = renderScene(rw, rh, e, Object.assign({}, baseOpts, cur.apply(cur.v)));
    const mod = (rw === W) ? modRaw : scaleImageData(modRaw, W, H);

    /* 复用一个离屏 canvas，避免每次拖动都新建 */
    if (!S._labOff) {
      S._labOff = document.createElement('canvas'); S._labOff.width = W; S._labOff.height = H;
      S._labOn = document.createElement('canvas'); S._labOn.width = W; S._labOn.height = H;
    }
    const off = S._labOff, on = S._labOn;
    off.getContext('2d').putImageData(base, 0, 0);
    on.getContext('2d').putImageData(mod, 0, 0);

    const ctx = cv.getContext('2d');
    paintLab();

    clearTimeout(labTimer);
    if (fast) labTimer = setTimeout(() => rebuild(false), 150);

    /* 色板对照在下面，单独抽出去以便拖分割线时跳过 */
    labAfterPaint(e, baseOpts);
  }

  /* 纯合成：按分割位置裁切两张已备好的图 */
  function paintLab() {
    if (!S._labOff || !S._labOn) return;
    const ctx = cv.getContext('2d');
    const sx = Math.round(W * S.labSplit);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(S._labOff, 0, 0, sx, H, 0, 0, sx, H);
    ctx.drawImage(S._labOn, sx, 0, W - sx, H, sx, 0, W - sx, H);
    $('#labHandle').style.left = (S.labSplit * 100) + '%';
  }

  function labAfterPaint(e, baseOpts) {

    /* 色板对照：中性灰 / 肤色 / 饱和红 / 冷蓝 */
    const spots = [[0.18, 0.18, 0.18, '中性灰'], [0.78, 0.53, 0.42, '肤色'], [0.85, 0.15, 0.10, '饱和红'], [0.08, 0.16, 0.42, '深蓝']];
    $('#labSwatches').innerHTML = spots.map(([r, g, b, n]) => {
      const a = e.render([r, g, b], baseOpts);
      const c = e.render([r, g, b], Object.assign({}, baseOpts, cur.apply(cur.v)));
      return `<div style="flex:1;min-width:74px">
        <div style="height:30px;border-radius:6px 6px 0 0;background:${hex(a)};border:1px solid var(--line);border-bottom:0"></div>
        <div style="height:30px;border-radius:0 0 6px 6px;background:${hex(c)};border:1px solid var(--line)"></div>
        <div style="font-family:var(--mono);font-size:8.5px;color:var(--ink-4);margin-top:5px;text-align:center;letter-spacing:.06em">${n}</div>
      </div>`;
    }).join('');
  }

  function select(i) {
    cur = LAB[i];
    cur.v = cur.val;
    $$('#labSeg button').forEach((b, k) => b.classList.toggle('on', k === i));
    $('#labGroup').textContent = cur.grp;
    $('#labName').textContent = cur.name;
    $('#labDesc').textContent = cur.desc;
    $('#labHint').innerHTML = cur.hint;
    $('#labTagB').textContent = '改动后';

    const s = $('#sLab');
    s.min = cur.min; s.max = cur.max; s.step = cur.step; s.value = cur.val;
    s.style.setProperty('--p', ((cur.val - cur.min) / (cur.max - cur.min) * 100) + '%');
    $('#labVal').textContent = cur.val.toFixed(cur.step < .1 ? 1 : (cur.step < 1 ? 2 : 0));
    rebuild(false);
  }

  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    select(+b.dataset.i);
  });

  $('#sLab').addEventListener('input', e => {
    const v = +e.target.value;
    cur.v = v;
    e.target.style.setProperty('--p', ((v - cur.min) / (cur.max - cur.min) * 100) + '%');
    $('#labVal').textContent = v.toFixed(cur.step < .1 ? 1 : (cur.step < 1 ? 2 : 0));
    rebuild(true);
  });

  /* 拖动分割线 */
  if (wrap) {
    S.labSplit = 0.5;
    const drag = e => {
      const r = wrap.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      S.labSplit = clamp(x / r.width, 0.02, 0.98);
      paintLab();                  /* 只重绘，不重算 */
    };
    wrap.addEventListener('pointerdown', e => {
      wrap.setPointerCapture(e.pointerId);
      drag(e);
      const mv = ev => drag(ev);
      const up = () => { wrap.removeEventListener('pointermove', mv); wrap.removeEventListener('pointerup', up); };
      wrap.addEventListener('pointermove', mv);
      wrap.addEventListener('pointerup', up);
    });
  }

  select(0);
  addEventListener('resize', rebuild);
  document.addEventListener('spektra:rebuild', rebuild);
}

/* --------------------------------------------------------------------------
   12. 滚动驱动：进度条 / 导航高亮 / 入场
   -------------------------------------------------------------------------- */
function initScroll() {
  const bar = $('#barProgress'), top = $('#topbar'), rail = $('#rail');
  const secs = $$('main section');

  const onScroll = () => {
    const y = scrollY;
    const max = document.body.scrollHeight - innerHeight;
    bar.style.width = (max > 0 ? y / max * 100 : 0) + '%';
    top.classList.toggle('is-stuck', y > 40);
    rail.classList.toggle('on', y > innerHeight * 0.6);

    let cur = '';
    for (const s of secs) {
      if (s.getBoundingClientRect().top <= innerHeight * 0.38) cur = s.id;
    }
    $$('.rail a').forEach(a => a.classList.toggle('act', a.dataset.s === cur));
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const io = new IntersectionObserver(en => {
    en.forEach(x => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  $$('.rv').forEach(e => io.observe(e));
}

/* --------------------------------------------------------------------------
   13. 胶片联动：换 stock 后重绘所有依赖引擎的图
   -------------------------------------------------------------------------- */
function rebuildAll() {
  ENGINE = SP.build(SP.FILMS[S.film], SP.PAPERS[S.paper], S.latitude);
  /* 换底后所有缓存图全部失效 */
  S._baNeutral = null;
  S._labBase = null;
  S._labMod = null;
  S._texBaseImg = null;
  if (S.redrawCurve) S.redrawCurve();
  if (S.redrawDevStrip) S.redrawDevStrip();
  if (S.redrawPrint) S.redrawPrint();
  if (S.redrawPrintBA) S.redrawPrintBA();
  document.dispatchEvent(new CustomEvent('spektra:rebuild'));
}

/* --------------------------------------------------------------------------
   8b. 换底：Stock / Paper 选择器 + Film 组滑块
   -------------------------------------------------------------------------- */
const STOCK_NOTES = {
  kodak_portra_400: '柔和、宽容、肤色友好。中性参考片，最适合先建立手感。',
  kodak_ultramax_400: '消费级负片，彩度更高、反差略硬，阴影偏冷。',
  kodak_vision3_500t: '电影灯片（T 型），低照度宽容度极好，阴影会自然偏青蓝。',
  kodak_ektar_100: '极高彩度与细颗粒，红橙特别饱满，曝光不足容易脏。',
  fujifilm_c200: '日系清新，绿青倾向明显，高光偏黄绿。',
  kodak_kodachrome_64: '反转片（正片）。显影完就是最终像，<b>没有印片阶段</b>，Paper 对它无效。宽容度窄、反差高，是幻灯片那种质感。'
};
const PAPER_NOTES = {
  kodak_supra_endura: '专业负片相纸，中性、宽容，是负片时代的标准印相纸。',
  kodak_ultra_endura: '消费级相纸，彩度更高、黑位略浅，日常冲印的味道。',
  kodak_2383: '电影印片正片，用于从负片印发行拷贝。黑极深、高光极实，反差明显更硬。'
};

function initStock() {
  const sf = $('#selFilm'), sp = $('#selPaper');
  if (!sf || !sp) return;

  sf.innerHTML = SP.FILMS.map((f, i) =>
    `<option value="${i}">${f.name}${f.kind === 'positive' ? '  · 反转片' : ''}</option>`).join('');
  sp.innerHTML = SP.PAPERS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');

  const note = () => {
    const f = SP.FILMS[S.film], p = SP.PAPERS[S.paper];
    const n = SP.NEUTRAL[f.stock + '|' + p.stock];
    const isPos = f.kind === 'positive';
    sp.disabled = isPos;
    sp.style.opacity = isPos ? .38 : 1;
    $('#stockNote').innerHTML = `
      <div>${STOCK_NOTES[f.stock] || ''}</div>
      ${isPos
        ? `<span class="warn">反转片没有印片阶段。本页会自动旁路 Paper、CMY 滤色、Printer Points 与预闪。</span>`
        : `<div style="margin-top:7px">${PAPER_NOTES[p.stock] || ''}</div>`}
      <div style="margin-top:9px;color:var(--ink-4);font-size:11.5px">
        这组底与纸的标称中性滤色：C ${n ? n[0].toFixed(1) : '—'} / M ${n ? n[1].toFixed(1) : '50.0'} / Y ${n ? n[2].toFixed(1) : '50.0'}
      </div>`;
  };

  sf.addEventListener('change', () => { S.film = +sf.value; note(); rebuildAll(); });
  sp.addEventListener('change', () => { S.paper = +sp.value; note(); rebuildAll(); });
  note();

  /* Film 组滑块 */
  const state = { ev: 0, gamma: 1, push: 0 };
  const wire = (id, out, key, dec, after) => {
    const s = $(id); if (!s) return;
    const f = () => {
      state[key] = +s.value;
      s.style.setProperty('--p', ((+s.value - +s.min) / (+s.max - +s.min) * 100) + '%');
      $(out).textContent = dec ? (+s.value).toFixed(dec) : Math.round(+s.value);
      if (after) after();
      drawAll();
    };
    s.addEventListener('input', f); f();
  };

  const secs = () => {
    const p = state.push;
    const t = p < 0 ? lerp(180, 150, Math.min(-p, 1))
      : (p <= 1 ? lerp(180, 220, p) : lerp(220, 280, Math.min(p - 1, 1)));
    return t;
  };

  /* 拖动时用 rAF 合并多次 input，避免一次拖动触发十几次全量重算 */
  let rafPending = 0;
  const drawAll = () => {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      S.pushVal = state.push;
      if (S.redrawCurve) S.redrawCurve();
      if (S.redrawPrint) S.redrawPrint();
      if (S.redrawDevStrip) S.redrawDevStrip();
      document.dispatchEvent(new CustomEvent('spektra:rebuild'));
    });
  };

  wire('#sFEV', '#oFEV', 'ev', 1);
  wire('#sFGamma', '#oFGamma', 'gamma', 2);
  wire('#sPush', '#oPush', 'push', 1, () => {
    const t = secs();
    $('#devSeconds').textContent = Math.round(t) + ' s';
    const pct = (t - 150) / (280 - 150) * 100;
    $('#devBarFill').style.right = (100 - pct) + '%';
  });

  /* 让所有 renderScene 调用带上当前 film 参数 */
  S.filmParams = state;
}

/* --------------------------------------------------------------------------
   8c. 统一渲染入口（带当前参数）
   -------------------------------------------------------------------------- */
const origRenderScene = renderScene;
renderScene = function (w, h, engine, opts = {}) {
  const fp = S.filmParams || {};
  return origRenderScene(w, h, engine, Object.assign({
    EVf: fp.ev || 0, gammaF: fp.gamma || 1, pushF: fp.push || 0
  }, opts));
};

/* --------------------------------------------------------------------------
   BOOT
   -------------------------------------------------------------------------- */
function boot() {
  initHero();
  initChain();
  initDensity();
  initSegTexts();
  initNodes();
  initParams();
  initScan();
  initScroll();
  const run = () => {
    initSpectrum();
    initStock();
    initCurve();
    initPrint();
    initTexture();
    initLab();
    rebuildAll();
  };
  (window.requestIdleCallback || (f => setTimeout(f, 1)))(run);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
