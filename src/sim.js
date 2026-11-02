/* ==========================================================================
   sim.js — 一个可在浏览器里跑的 spektrafilm 成像链「教学版」微型实现
   --------------------------------------------------------------------------
   这里刻意保留插件真实的结构顺序与数学形态：
     线性RGB → 光谱上采样(3基函数) → 胶片层曝光 → log10 → 特性曲线 → CMY 密度
     → 染料光谱 → 印片光过滤 → 相纸敏感度积分 → 相纸特性曲线 → 相纸 CMY 密度
     → 扫描光源 → CIE 三刺激值 → 输出 RGB
   为教学可读性与实时性，做了几处简化（页面中会明确标注）：
     - 光谱用 3 条高斯基函数近似 Hanatos 可见轨迹 LUT（真实插件是 2D LUT）
     - 只取单一 3×3 抑制项，不跑 DIR 的二维扩散
     - 灰阶/曝光使用迭代求得的标称中性滤色（取自插件 neutral_print_filters.json）
   ========================================================================== */

const SP = (() => {
  const N = WL.length;
  const DL = (WL[N - 1] - WL[0]) / (N - 1);
  const LN10 = Math.LN10;

  /* ---------- 光谱基础设施 ---------- */
  const planckRaw = (l, T) => {
    const lm = l * 1e-9, c2 = 1.4388e-2;
    return 1 / (Math.pow(lm, 5) * (Math.exp(c2 / (lm * T)) - 1));
  };
  const planck = (l, T) => planckRaw(l, T) / planckRaw(555, T);

  const g1 = (l, mu, s1, s2) => {
    const t = (l - mu) / (l < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  /* CIE 1931 多高斯拟合 */
  const CM = WL.map(l => [
    1.056 * g1(l, 599.8, 37.9, 31.0) + 0.362 * g1(l, 442.0, 16.0, 26.7) - 0.065 * g1(l, 501.1, 20.4, 26.2),
    0.821 * g1(l, 568.8, 46.9, 40.5) + 0.286 * g1(l, 530.9, 16.3, 31.1),
    1.217 * g1(l, 437.0, 11.8, 36.0) + 0.681 * g1(l, 459.0, 26.0, 13.8)
  ]);

  /* 三条光谱基函数，用于把 RGB 还原成一条连续光谱（Mallett/Yuksel 思路） */
  const B = [[615, 25.5], [540, 18.7], [460, 17]];
  const BSUM = B.map(([mu, s]) => WL.reduce((a, l) => a + Math.exp(-0.5 * ((l - mu) / s) ** 2), 0) * DL);
  const BASIS = WL.map(l => B.map(([mu, s], c) => Math.exp(-0.5 * ((l - mu) / s) ** 2) / BSUM[c]));

  const sig = v => Math.pow(10, v);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* RGB → 光谱 */
  function spectrumFromRGB(rgb, illum) {
    return WL.map((l, i) =>
      illum[i] * (rgb[0] * BASIS[i][0] + rgb[1] * BASIS[i][1] + rgb[2] * BASIS[i][2]));
  }

  /* ---------- 曲线工具 ---------- */
  function interp(xs, rows, x, ch) {
    if (x <= xs[0]) return rows[0][ch];
    const last = xs.length - 1;
    if (x >= xs[last]) return rows[last][ch];
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= x) lo = m; else hi = m;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return rows[lo][ch] + (rows[hi][ch] - rows[lo][ch]) * t;
  }
  function interpT(xs, rows, x) {
    return [0, 1, 2].map(c => interp(xs, rows, x, c));
  }
  /* 单标量版：热路径专用，避免闭包分配 */
  function interp1(xs, rows, x, ch) {
    if (x <= xs[0]) return rows[0][ch];
    const last = xs.length - 1;
    if (x >= xs[last]) return rows[last][ch];
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= x) lo = m; else hi = m;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return rows[lo][ch] + (rows[hi][ch] - rows[lo][ch]) * t;
  }
  function solveX(xs, ys, target) {
    for (let i = 1; i < ys.length; i++) {
      const a = ys[i - 1], b = ys[i];
      if ((a - target) * (b - target) <= 0 && a !== b)
        return xs[i - 1] + (xs[i] - xs[i - 1]) * (target - a) / (b - a);
    }
    return xs[0];
  }

  /* ---------- 胶片侧：层敏感度矩阵 ---------- */
  function rawMatrix(prof) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let c = 0; c < 3; c++) for (let m = 0; m < 3; m++) {
      let s = 0;
      for (let i = 0; i < N; i++) s += sig(prof.sens[i][m]) * BASIS[i][c] * DL;
      M[m][c] = s;
    }
    return M;
  }
  const mul = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  function mulInto(M, v, out) {
    const a = Math.max(0, v[0]), b = Math.max(0, v[1]), c = Math.max(0, v[2]);
    out[0] = M[0][0] * a + M[0][1] * b + M[0][2] * c;
    out[1] = M[1][0] * a + M[1][1] * b + M[1][2] * c;
    out[2] = M[2][0] * a + M[2][1] * b + M[2][2] * c;
    return out;
  }

  /* 中性滤色（真实值，取自插件 resources/data/filters/neutral_print_filters.json） */
  const NEUTRAL = {
    'kodak_portra_400|kodak_supra_endura': [0, 52.43, 55.9],
    'kodak_portra_400|kodak_ultra_endura': [0, 51.98, 55.53],
    'kodak_portra_400|kodak_2383': [0, 60.07, 65.16],
    'kodak_ultramax_400|kodak_supra_endura': [0, 58.60, 61.96],
    'kodak_ultramax_400|kodak_ultra_endura': [0, 58.28, 61.46],
    'kodak_ultramax_400|kodak_2383': [0, 66.42, 69.69],
    'kodak_vision3_500t|kodak_supra_endura': [0, 29.30, 38.07],
    'kodak_vision3_500t|kodak_ultra_endura': [0, 38.82, 48.15],
    'kodak_vision3_500t|kodak_2383': [0, 46.01, 57.59],
    'kodak_ektar_100|kodak_supra_endura': [0, 74.39, 62.56],
    'kodak_ektar_100|kodak_ultra_endura': [0, 72.33, 60.02],
    'kodak_ektar_100|kodak_2383': [0, 80.76, 69.83],
    'fujifilm_c200|kodak_supra_endura': [0, 71.89, 87.97],
    'fujifilm_c200|kodak_ultra_endura': [0, 77.26, 93.15],
    'fujifilm_c200|kodak_2383': [0, 155.57, 30.86],
    'kodak_kodachrome_64|kodak_supra_endura': [0, 50, 50],
    'kodak_kodachrome_64|kodak_ultra_endura': [0, 50, 50],
    'kodak_kodachrome_64|kodak_2383': [0, 50, 50]
  };
  const neutralFor = (f, p) => NEUTRAL[f.stock + '|' + p.stock] || [0, 50, 50];

  /* ---------- 印片滤色片（Durst 二向色，真实透过率曲线） ---------- */
  const ENL = WL.map(l => planck(l, 2856)); // TH-KG3 卤素灯
  function filterTrans(c, m, y) {
    const wheel = [c, m, y].map(v => Math.pow(10, -Math.max(v, 0) / 100));
    return WL.map((l, i) => {
      let t = 1;
      const raw = [FILTERS.c[i], FILTERS.m[i], FILTERS.y[i]];
      for (let k = 0; k < 3; k++) t *= 1 - (1 - raw[k]) * (1 - wheel[k]);
      return t;
    });
  }

  /* ---------- 每个 Stock×Paper 组合编译成一个「成像机」 ---------- */
  const cache = new Map();

  function build(film, paper, latitude = 0.5, forceScan = false) {
    const positive = forceScan || film.kind === 'positive';
    const key = film.stock + '|' + paper.stock + '|' + latitude + '|' + (positive ? 'pos' : 'neg');
    if (cache.has(key)) return cache.get(key);

    const MF = rawMatrix(film);
    const MP = rawMatrix(paper);
    const neutral = neutralFor(film, paper);

    /* 胶片：把 18% 中灰放到特性曲线的固定位置，得到该组合的偏置。
       负片与反转片的曲线定义不同：负片密度随曝光上升，反转片相反
       （曝光越多、染料越少），所以中灰落点也不同。 */
    const GRAY_TARGET = positive ? 1.05 : 0.62;
    const offF = [0, 1, 2].map(m =>
      solveX(film.le, film.d.map(r => r[m]), GRAY_TARGET) - Math.log10(mul(MF, [0.18, 0.18, 0.18])[m]));
    /* 每层 18% 灰落在曲线上的 log 曝光位置（各层不同，这正是色彩分离的来源） */
    const grayFm = [0, 1, 2].map(m =>
      solveX(film.le, film.d.map(r => r[m]), GRAY_TARGET));

    function filmDensity(rgb, o = {}) {
      return Array.from(filmDensityInto(rgb, o.EV || 0, o.gamma || 1, o.push || 0, new Float64Array(3)));
    }
    function filmDensityInto(rgb, EV, gamma, push, out) {
      const raw = mulInto(MF, rgb, _raw);
      const dev = push >= 0
        ? (push <= 1 ? Math.pow(220 / 180, push)
                     : Math.pow(220 / 180, 1) * Math.pow(280 / 220, push - 1))
        : Math.pow(150 / 180, -push);
      const eff = gamma * dev;
      const ex = Math.pow(2, EV);
      const FLE = film.le, FD = film.d;
      out[0] = Math.max(0, interp1(FLE, FD, (Math.log10(Math.max(raw[0] * ex, 1e-12)) + offF[0]) * eff, 0));
      out[1] = Math.max(0, interp1(FLE, FD, (Math.log10(Math.max(raw[1] * ex, 1e-12)) + offF[1]) * eff, 1));
      out[2] = Math.max(0, interp1(FLE, FD, (Math.log10(Math.max(raw[2] * ex, 1e-12)) + offF[2]) * eff, 2));
      return out;
    }

    const filmSpec = Dm => WL.map((l, i) => {
      let d = film.base[i];
      for (let m = 0; m < 3; m++) d += Dm[m] * film.dye[i][m];
      return d;
    });

    const NF = filterTrans(neutral[0], neutral[1], neutral[2]);

    /* ---- 预计算：这些东西与像素无关，不该每像素重算 ---- */
    /* 相纸层敏感度转成线性，避免每像素 123 次 pow */
    const PSENS = new Float64Array(N * 3);
    for (let i = 0; i < N; i++) for (let m = 0; m < 3; m++) PSENS[i * 3 + m] = sig(paper.sens[i][m]);
    /* 相纸片基密度透过率 */
    const PBASE_T = new Float64Array(N);
    for (let i = 0; i < N; i++) PBASE_T[i] = Math.exp(-paper.base[i] * LN10);

    /* 滤色缓存：同一组 (c,m,y) 只积分一次，滑块连续拖动时命中率很高 */
    const filtCache = new Map();
    function filterFor(c, m, y) {
      const k = c.toFixed(1) + ',' + m.toFixed(1) + ',' + y.toFixed(1);
      let f = filtCache.get(k);
      if (!f) {
        f = Float64Array.from(filterTrans(c, neutral[1] + m, neutral[2] + y));
        if (filtCache.size > 96) filtCache.clear();
        filtCache.set(k, f);
      }
      return f;
    }

    /* 复用缓冲区，避免每像素分配数组 */
    const _raw = new Float64Array(3);
    const _Df = new Float64Array(3);
    const _Dspec = new Float64Array(N);
    const _rawP = new Float64Array(3);
    const _Dp = new Float64Array(3);

    function paperRawInto(Df, filt, out) {
      let o0 = 0, o1 = 0, o2 = 0;
      for (let i = 0; i < N; i++) {
        const L = ENL[i] * filt[i] * Math.exp(-Df[i] * LN10);
        const b = i * 3;
        o0 += L * PSENS[b];
        o1 += L * PSENS[b + 1];
        o2 += L * PSENS[b + 2];
      }
      out[0] = o0 * DL; out[1] = o1 * DL; out[2] = o2 * DL;
      return out;
    }
    const paperRaw = (Df, filt) => paperRawInto(Df, filt, new Float64Array(3));

    const grayRaw = paperRaw(filmSpec(filmDensity([0.18, 0.18, 0.18])), NF);
    const offP = [0, 1, 2].map(m =>
      solveX(paper.le, paper.d.map(r => r[m]), 0.55) - Math.log10(grayRaw[m]));
    const GRAY = Math.log10(grayRaw[0]) + offP[0];

    /* 相纸 dmax（用于 shadow/highlight 塑形），一次算好 */
    const paperDmax = [0, 1, 2].map(m => Math.max(...paper.d.map(r => r[m])));
    /* paper.le 的插值辅助：把 log 曝光映射到密度（三条通道一起） */
    const PLE = paper.le, PD = paper.d, PN = PLE.length;

    function printDensityInto(rgb, o, outD) {
      const EVf = o.EVf || 0, gammaF = o.gammaF || 1, pushF = o.pushF || 0;
      const cF = o.cF || 0, mF = o.mF || 0, yF = o.yF || 0;
      const EVp = o.EVp || 0, gammaP = o.gammaP || 1, pushP = o.pushP || 0;
      const pR = o.pR || 0, pG = o.pG || 0, pB = o.pB || 0;
      const preflash = o.preflash || 0, shadow = o.shadow || 0, highlight = o.highlight || 0;

      /* --- 胶片显影 --- */
      filmDensityInto(rgb, EVf, gammaF, pushF, _Df);
      /* --- 负片光谱密度 --- */
      for (let i = 0; i < N; i++) {
        _Dspec[i] = film.base[i] + _Df[0] * film.dye[i][0] + _Df[1] * film.dye[i][1] + _Df[2] * film.dye[i][2];
      }
      /* --- 印片积分 --- */
      const filt = filterFor(cF, mF, yF);
      paperRawInto(_Dspec, filt, _rawP);

      const effG = gammaP * Math.pow(2, pushP * 0.25);
      const ex = Math.pow(2, EVp);
      const pp0 = Math.pow(2, pR / 12), pp1 = Math.pow(2, pG / 12), pp2 = Math.pow(2, pB / 12);
      const e0 = ex * pp0, e1 = ex * pp1, e2 = ex * pp2;

      let pre0 = 0, pre1 = 0, pre2 = 0;
      if (preflash > 0) {
        pre0 = grayRaw[0] * preflash * e0;
        pre1 = grayRaw[1] * preflash * e1;
        pre2 = grayRaw[2] * preflash * e2;
      }

      const r0 = _rawP[0] * e0 + pre0;
      const r1 = _rawP[1] * e1 + pre1;
      const r2 = _rawP[2] * e2 + pre2;

      /* --- 相纸显影曲线 --- */
      outD[0] = Math.max(0, interp1(PLE, PD, (GRAY + (Math.log10(Math.max(r0, 1e-12)) + offP[0] - GRAY) * latitude) * effG, 0));
      outD[1] = Math.max(0, interp1(PLE, PD, (GRAY + (Math.log10(Math.max(r1, 1e-12)) + offP[1] - GRAY) * latitude) * effG, 1));
      outD[2] = Math.max(0, interp1(PLE, PD, (GRAY + (Math.log10(Math.max(r2, 1e-12)) + offP[2] - GRAY) * latitude) * effG, 2));

      /* --- 暗部/亮部塑形 --- */
      if (shadow || highlight) {
        for (let m = 0; m < 3; m++) {
          const dm = paperDmax[m];
          const n = clamp(outD[m] / dm, 0, 1);
          const sB = n * n * (1 - n), hB = n * (1 - n) * (1 - n);
          outD[m] = clamp(n - 0.5 * shadow * sB - 0.5 * highlight * hB, 0, 1) * dm;
        }
      }
      return outD;
    }
    const printDensity = (rgb, o = {}) => Array.from(printDensityInto(rgb, o, new Float64Array(3)));

    /* ---------- 扫描：密度 → 光谱 → XYZ → RGB ---------- */
    const D50 = WL.map(l => planck(l, 5000));
    /* 预计算：D50(λ)·CMF(λ)·Δλ 合成一个 3 分量表，省掉每像素 3 次乘 */
    const SCAN_W = new Float64Array(N * 3);
    let YN_NORM = 0;
    for (let i = 0; i < N; i++) {
      SCAN_W[i * 3] = D50[i] * CM[i][0] * DL;
      SCAN_W[i * 3 + 1] = D50[i] * CM[i][1] * DL;
      SCAN_W[i * 3 + 2] = D50[i] * CM[i][2] * DL;
      YN_NORM += SCAN_W[i * 3 + 1];
    }
    YN_NORM = 1 / YN_NORM;

    const PAPER_DYE = paper.dye, FILM_DYE = film.dye;
    const PAPER_BASE = paper.base, FILM_BASE = film.base;

    function scanXYZInto(Dp, stage, out) {
      let x = 0, y = 0, z = 0;
      if (stage === 'film') {
        for (let i = 0; i < N; i++) {
          const d = FILM_BASE[i] + Dp[0] * FILM_DYE[i][0] + Dp[1] * FILM_DYE[i][1] + Dp[2] * FILM_DYE[i][2];
          const T = Math.exp(-d * LN10);
          const b = i * 3;
          x += SCAN_W[b] * T; y += SCAN_W[b + 1] * T; z += SCAN_W[b + 2] * T;
        }
      } else {
        for (let i = 0; i < N; i++) {
          const d = PAPER_BASE[i] + Dp[0] * PAPER_DYE[i][0] + Dp[1] * PAPER_DYE[i][1] + Dp[2] * PAPER_DYE[i][2];
          const T = Math.exp(-d * LN10);
          const b = i * 3;
          x += SCAN_W[b] * T; y += SCAN_W[b + 1] * T; z += SCAN_W[b + 2] * T;
        }
      }
      out[0] = x * YN_NORM; out[1] = y * YN_NORM; out[2] = z * YN_NORM;
      return out;
    }
    const scanXYZ = (Dp, stage) => Array.from(scanXYZInto(Dp, stage, new Float64Array(3)));

    const BRAD = [[1.0478, 0.0229, -0.0501], [0.0296, 0.9905, -0.0171], [-0.0092, 0.0151, 0.7520]];
    const X2R = [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]];
    /* BRAD·X2R 合成一个矩阵，省一次 3×3 */
    const M_SCAN = (() => {
      const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += X2R[i][k] * BRAD[k][j];
        o[i][j] = s;
      }
      return o;
    })();
    const _xyz = new Float64Array(3);
    const _lin = new Float64Array(3);
    function linInto(Dp, stage, out) {
      scanXYZInto(Dp, stage, _xyz);
      out[0] = Math.max(0, M_SCAN[0][0] * _xyz[0] + M_SCAN[0][1] * _xyz[1] + M_SCAN[0][2] * _xyz[2]);
      out[1] = Math.max(0, M_SCAN[1][0] * _xyz[0] + M_SCAN[1][1] * _xyz[1] + M_SCAN[1][2] * _xyz[2]);
      out[2] = Math.max(0, M_SCAN[2][0] * _xyz[0] + M_SCAN[2][1] * _xyz[1] + M_SCAN[2][2] * _xyz[2]);
      return out;
    }
    const lin = (Dp, stage) => Array.from(linInto(Dp, stage, new Float64Array(3)));
    const enc = v => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

    const wLin = lin([0, 0, 0], 'paper');
    const GAIN = wLin.map(v => 0.92 / Math.max(v, 1e-6));

    function toSrgb255(rgbLin) {
      return rgbLin.map((v, i) => clamp(enc(v * GAIN[i]), 0, 1) * 255);
    }

    /* ---- 反转片（正片）：直接扫描胶片本身 ---- */
    const filmDmax = [0, 1, 2].map(m => Math.max(...film.d.map(r => r[m])));
    const filmDmin = [0, 1, 2].map(m => Math.min(...film.d.map(r => r[m])));
    const filmWhite = lin(filmDmin, 'film');   // 幻灯片最透亮处
    const filmBlack = lin(filmDmax, 'film');   // 幻灯片最黑处
    const filmWhiteSpan = filmWhite.map((w, i) => Math.max(w - filmBlack[i], 1e-6));

    /* 反转片的染料三层并不互相抵消成中性（这是幻灯片偏色的一部分）。
       为了让「中性灰输入 → 中性灰输出」，求解一组密度微调量。 */
    let posBal = [0, 0, 0];
    if (positive) {
      const target = [0.18, 0.18, 0.18];
      for (let it = 0; it < 24; it++) {
        const D = filmDensity([0.18, 0.18, 0.18]).map((v, m) => clamp(v + posBal[m], 0, filmDmax[m]));
        const L = lin(D, 'film');
        const out = L.map((v, i) => clamp((v - filmBlack[i]) / Math.max(filmWhite[i] - filmBlack[i], 1e-6), 0, 1));
        const want = Math.pow(0.18, 1 / 2.2) * 0.62;
        for (let m = 0; m < 3; m++) {
          /* 输出偏亮 → 加密度；偏暗 → 减密度 */
          const err = Math.log(Math.max(out[m], 1e-6) / Math.max(want, 1e-6));
          posBal[m] = clamp(posBal[m] + err * 0.55, -filmDmax[m] * 0.9, filmDmax[m] * 0.9);
        }
      }
    }

    function positiveRender(rgb, o = {}) {
      const D = filmDensity(rgb, { EV: o.EVf || 0, gamma: o.gammaF || 1, push: o.pushF || 0 })
        .map((v, m) => clamp(v + posBal[m], 0, filmDmax[m]));
      const L = lin(D, 'film');
      return L.map((v, i) => clamp(enc(clamp((v - filmBlack[i]) / Math.max(filmWhite[i] - filmBlack[i], 1e-6), 0, 1)), 0, 1) * 255);
    }

    const _rD = new Float64Array(3);
    const _rL = new Float64Array(3);

    const api = {
      film, paper, positive, neutral, calibrate: { offF, offP, grayF: Math.log10(grayRaw[0]) + offF[0], grayFm },
      filmDensity, printDensity, filmSpec, scanXYZ, lin,
      toSrgb255,
      /* 热路径：写入调用方给的 out，不分配 */
      renderInto(rgb, o, out) {
        if (positive) {
          const D = filmDensityInto(rgb, o.EVf || 0, o.gammaF || 1, o.pushF || 0, _rD);
          for (let m = 0; m < 3; m++) _rD[m] = clamp(_rD[m] + posBal[m], 0, filmDmax[m]);
          linInto(_rD, 'film', _rL);
          for (let i = 0; i < 3; i++) {
            const u = clamp((_rL[i] - filmBlack[i]) / filmWhiteSpan[i], 0, 1);
            out[i] = clamp(enc(u), 0, 1) * 255;
          }
          return out;
        }
        printDensityInto(rgb, o, _rD);
        linInto(_rD, 'paper', _rL);
        for (let i = 0; i < 3; i++) out[i] = clamp(enc(_rL[i] * GAIN[i]), 0, 1) * 255;
        return out;
      },
      render(rgb, o) {
        /* 正片（反转片）没有印片阶段 —— 显影完就是最终像，直接扫描 */
        if (positive) return positiveRender(rgb, o);
        return toSrgb255(lin(printDensity(rgb, o), 'paper'));
      },
      scan(rgbLin) { return toSrgb255(rgbLin); },
      scanLinear(Dp) { return lin(Dp, 'paper'); },
      dmax: positive ? filmDmax : [0, 1, 2].map(m => Math.max(...paper.d.map(r => r[m]))),
      grayRaw,
      filmScan(rgb, o) {
        const L = lin(filmDensity(rgb, { EV: o?.EVf || 0, gamma: o?.gammaF || 1, push: o?.pushF || 0 }), 'film');
        const w = lin([0, 0, 0], 'film');
        return L.map((v, i) => clamp(enc(v / Math.max(w[i], 1e-6)), 0, 1) * 255);
      }
    };
    cache.set(key, api);
    return api;
  }

  /* 曲线工具导出给绘图用 */
  function curvePoints(prof, ch, n = 160, gamma = 1, shift = 0) {
    const pts = [];
    const x0 = prof.le[0], x1 = prof.le[prof.le.length - 1];
    for (let i = 0; i < n; i++) {
      const x = x0 + (x1 - x0) * i / (n - 1);
      pts.push([x, Math.max(0, interp(prof.le, prof.d, (x + shift) * gamma, ch))]);
    }
    return pts;
  }

  return {
    WL, DL, CM, BASIS, BSUM, planck, filterTrans, build, curvePoints,
    interp, interpT, interpRaw: interp, FILMS, PAPERS, FILTERS, NEUTRAL,
    clamp, mul, spectrumFromRGB
  };
})();

if (typeof window !== 'undefined') window.SP = SP;
