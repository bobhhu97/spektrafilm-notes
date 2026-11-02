/* ==========================================================================
   content.js — 阶段说明 + 完整参数索引
   参数名/分组/取值范围全部对照 spektrafilm-ofx 源码 SpektraFilmPlugin.cpp
   与 SpektraParameters.h 整理；说明文字为本次教学化重写。
   ========================================================================== */

/* ---------- 8 个成像站 ---------- */
const STATIONS = [
  {
    id: 'input', n: '01', t: '输入解码', u: '线性光', stage: 'Color Management',
    in: 'Resolve 送进来的像素（可能是 Log 编码）',
    out: '场景线性 RGB',
    body: `插件拿到的素材未必是线性的。LogC4、S-Log3、BMD Film 全都是「用曲线压缩过的」
    编码值。第一步必须把它们还原成<b>与光成正比的线性值</b>，否则后面所有"曝光翻倍"都是错的。
    这一步还会把白点适配到该胶片 profile 的参考光源。`,
    pills: ['Input Color Space', 'Output Role', 'sdrOutputColorSpace'],
    math: 'decoded = TF⁻¹(encoded)  →  linear = M_gamut · decoded',
    why: '这里选错，画面会整体偏色或反差错误。后面再怎么调也救不回来，因为错误已经被当成胶片响应的一部分算进去了。'
  },
  {
    id: 'upsample', n: '02', t: '光谱上采样', u: 'RGB → 连续光谱', stage: 'Film · RGB to Raw',
    in: '场景线性 RGB 三元组',
    out: '可见光波段光谱 S(λ) + 三层乳剂曝光 raw',
    body: `三个数字不足以唯一确定一条光谱，这叫<b>同色异谱</b>。插件的做法是把 RGB 当作
    一个色度坐标，在"可见光轨迹"上找一条<b>平滑、正数、合理</b>的光谱，再让它和胶片三层的
    感光曲线积分，得到各层的曝光量。`,
    pills: ['RGB to Raw', 'Filter UV / IR'],
    math: 'raw_m = ∫ S(λ) · Q_m(λ) dλ',
    why: '饱和色能被分开，根源就在这一步。跳过它，整条链退化成矩阵近似。'
  },
  {
    id: 'expose', n: '03', t: '胶片曝光', u: '光量', stage: 'Film',
    in: '三层 raw 曝光',
    out: 'log₁₀ 曝光',
    body: `在进入曲线之前，所有曝光控制都在这里：Film Exposure EV、Auto Exposure、UV/IR 滤镜。
    曝光以 2 的幂次缩放，再取以 10 为底的对数，因为<b>特性曲线的横轴就是 log 曝光</b>。`,
    pills: ['filmExposureEv', 'autoExposure', 'Film Push / Pull'],
    math: 'log_raw_m = log₁₀( max(raw_m · 2^EV, ε) )',
    why: '这里的 +1EV 和印片组的 +1EV 效果完全不同：一个改变了底片落在曲线上的位置，一个只是印得更亮。'
  },
  {
    id: 'develop', n: '04', t: '显影', u: '密度', stage: 'Film · Density',
    in: 'log 曝光',
    out: 'CMY 三层染料密度',
    body: `查曲线。厂商测得的 log 曝光 → 密度数据被存成查找表，每条通道一条曲线。
    Gamma 整体缩放横轴，Push/Pull 用真实显影时间比例改变斜率，并把曲线按趾部/中间调/肩部
    分别扭曲。`,
    pills: ['filmGamma', 'filmPushPullStops', 'negativeBleachBypassAmount'],
    math: 'D_m = curve_m( log_raw_m · γ_eff )',
    why: '胶片的对比度就是这条曲线。用 Lift/Gamma/Gain 改反差是另一回事，改的是显示，不是化学。'
  },
  {
    id: 'coupler', n: '05', t: 'DIR 耦合', u: '层间抑制', stage: 'DIR Couplers',
    in: '各层银盐密度',
    out: '修正后的曝光（再显影一次）',
    body: `真实胶片里，显影时释放的抑制物会扩散到邻近层，压制它们的显影量。
    这带来两个结果：<b>层内</b>压高光（局部反差），<b>层间</b>压串色（色彩分离）。
    插件用 3×3 抑制矩阵 + 可选的高斯扩散来模拟，然后把修正后的曝光<b>再跑一遍曲线</b>。`,
    pills: ['dirAmount', 'dirInhibitionSameLayer', 'dirInhibitionInterlayer', 'dirDiffusionUm'],
    math: 'ΔlogR_m = G_σ( Σ_k D_k · M_k,m )   →   redevelop',
    why: '厚重感和颜色分离都来自这里。它比单纯加饱和度自然，因为暗部与亮部的分离方式不一样。'
  },
  {
    id: 'print', n: '06', t: '光学印片', u: '滤光', stage: 'Print',
    in: '负片光谱密度',
    out: '相纸 CMY 密度',
    body: `放大机的光穿过负片（滤掉一部分）、穿过二向色滤片（再滤一部分），
    照到相纸上。相纸按它自己的感光曲线响应。CMY 滤色、Printer Points、曝光、预闪
    全都在这一站。`,
    pills: ['filterC', 'filterMShift', 'Printer Points', 'preflashExposure', 'printExposureEv'],
    math: 'raw_paper_m = ∫ L_enl(λ)·10^−D_film(λ)·Q_paper_m(λ) dλ',
    why: '调色的主战场。但记住：这里改的是"印"，不是"底片"。'
  },
  {
    id: 'texture', n: '07', t: '质感叠加', u: '颗粒 / 光晕', stage: 'Grain · Halation · Diffusion',
    in: '密度场',
    out: '带随机结构的密度场',
    body: `颗粒在<b>密度空间</b>里按粒子统计生成；卤化在<b>曝光空间</b>里做反向散射；
    扩散则在曝光之前（相机）或印片之后（印片）做点扩散函数卷积。
    位置不同，物理意义就不同。`,
    pills: ['grainModel', 'halationAmount', 'cameraDiffusionStrength'],
    math: 'D_grain = N_developed · D_max / n',
    why: '这是 spektrafilm 最"像胶片"的部分，也是最容易用错的部分。'
  },
  {
    id: 'scan', n: '08', t: '扫描输出', u: 'RGB', stage: 'Scanner · Output',
    in: '相纸（或负片）光谱密度',
    out: '显示 RGB / HDR / RCM 场景值',
    body: `扫描光源穿过密度 → 得到光谱 → 与 CIE 三刺激值积分 → XYZ → 目标色域。
    这里还可以加扫描光晕、光学模糊、USM 锐化，以及黑白场校正。`,
    pills: ['glarePercent', 'scannerMtf50LpMm', 'scannerUnsharpAmount', 'outputRole'],
    math: 'XYZ = Σ I(λ)·10^−D(λ)·x̄ȳz̄(λ) / Σ I(λ)·ȳ(λ)',
    why: '决定"像不像扫描件"。也是唯一一处你该关心输出色彩空间的地方。'
  }
];

/* ---------- 完整参数索引（按插件 UI 分组） ---------- */
const PARAM_GROUPS = [
  {
    id: 'colorGroup', name: 'Color Management', zh: '色彩管理',
    params: [
      { k: 'process', n: 'Mode', r: 'Print simulation / Scan negative / Process negative',
        d: '三种处理模式。Print simulation 走完整负片→印片链；Scan negative 只到负片扫描，可直接看底片；Process negative 用固定负片参数走印片链，适合批量统一。' },
      { k: 'scanNegativeInvert', n: 'Invert Negative Scan', r: 'bool',
        d: '仅 Scan negative 模式：用片基/Dmax 参考把负片扫描归一化并反相，变成可看的正像。关掉则输出负片光。' },
      { k: 'inputColorSpace', n: 'Input Color Space', r: '26 种',
        d: '进入节点数据的色彩空间。必须与实际素材一致，否则解码错误。支持 ARRI、BMD、RED、Sony、Canon、Panasonic、ACES 全系。' },
      { k: 'outputRole', n: 'Output Role', r: 'Display SDR / Display HDR / RCM-ACES',
        d: '决定这一站之后是谁在做显示变换。选 RCM 时插件输出场景值，下游 Resolve 自己转显示；选 SDR/HDR 时插件就是最后一环。' },
      { k: 'sdrOutputColorSpace', n: 'Output Color Space (SDR)', r: 'sRGB / Rec.709 γ2.2 / γ2.4 / P3 等',
        d: 'Display Out SDR 的目标色域与传递函数。默认 Rec.709 Gamma 2.4。' },
      { k: 'hdrPreset', n: 'HDR Preset', r: 'PQ1000 / PQ4000 / HLG1000 / Custom',
        d: 'HDR 交付预设。手动改动任一 HDR 参数会自动切到 Custom。' },
      { k: 'hdrTransfer', n: 'HDR Transfer', r: 'ST2084 (PQ) / HLG',
        d: 'HDR 编码曲线。PQ 适合监看级绝对亮度；HLG 更适合广播兼容。' },
      { k: 'hdrReferenceWhiteNits', n: 'Reference White Nits', r: '48 – 1000',
        d: '把扫描白映射到多少尼特。默认 203 nit，是 HDR 调色的常见参考白。' },
      { k: 'hdrPeakNits', n: 'Peak Nits', r: '100 – 10000',
        d: 'HDR 峰值亮度，用于色调映射与 PQ/HLG 缩放。' },
      { k: 'hdrExposureEv', n: 'HDR Exposure EV', r: '−8 – +8',
        d: '扫描后的 HDR 亮度微调，不影响胶片模型本身。' },
      { k: 'hdrToneMapping', n: 'HDR Tone Mapping', r: 'Soft Rolloff / Hard Clip',
        d: '超过参考白的高光怎么处理。Soft 给柔和肩部；Hard Clip 保留到峰值的校准余量。' },
      { k: 'colorAdaptation', n: 'Color Adaptation', r: 'bool',
        d: '实验性：对 Hanatos 输入做可见轨迹压缩，对 SDR/HDR 输出做 OKLch 感知色域压缩。关掉则走旧的 SDR 管线。' },
      { k: 'colorAdaptationInputCompression', n: 'Input Compression', r: 'bool',
        d: '使用可见轨迹压缩后的 Hanatos 响应做 RGB→raw，减少极饱和色的溢出。' },
      { k: 'colorAdaptationCurveSmoothing', n: 'Curve Smoothing', r: 'bool',
        d: '特性曲线改用单调三次插值，消除查表的折线感（暗部尤其明显）。' },
      { k: 'colorAdaptationOutputLightnessCompression', n: 'Output Lightness Compression', r: 'bool',
        d: '显示编码前应用 OKLch 亮度膝点，避免高光生硬截断。' },
      { k: 'colorAdaptationOutputChromaCompression', n: 'Output Chroma Compression', r: 'bool',
        d: '按目标显示色域压缩彩度，减少出界色。' }
    ]
  },
  {
    id: 'filteringGroup', name: 'Filtering', zh: '相机侧滤镜',
    params: [
      { k: 'cameraUvFilterEnabled', n: 'Filter UV', r: 'bool',
        d: '在胶片曝光前切掉紫外。真实相机镜头前都有 UV 滤镜，去掉后蓝紫色会明显更"飘"。' },
      { k: 'cameraUvCutNm', n: 'UV Cut nm', r: '380 – 450 nm',
        d: 'UV 截止转捩点的中心波长。数值越低，保留的紫色光越多。' },
      { k: 'cameraIrFilterEnabled', n: 'Filter IR', r: 'bool',
        d: '切掉红外。不切的话深红会异常发亮，肤色偏红。' },
      { k: 'cameraIrCutNm', n: 'IR Cut nm', r: '600 – 780 nm',
        d: 'IR 截止中心波长。数值越高，保留的深红越多。' }
    ]
  },
  {
    id: 'enlargerGroup', name: 'Film Plane', zh: '片窗 / 放大',
    params: [
      { k: 'enlargerScale', n: 'Scale', r: '1 – 32×',
        d: '放大片窗采样的区域。数值越大，取景越小，物理颗粒看起来越大。相当于换长焦或走近。' },
      { k: 'enlargerOffsetXPercent', n: 'Offset X %', r: '−100 – 100',
        d: '片窗水平平移，单位是可见画幅的百分比。' },
      { k: 'enlargerOffsetYPercent', n: 'Offset Y %', r: '−100 – 100',
        d: '片窗垂直平移。' }
    ]
  },
  {
    id: 'filmGroup', name: 'Film', zh: '负片',
    params: [
      { k: 'rgbToRawMethod', n: 'RGB to Raw', r: 'Hanatos 2026 / Hanatos 2025 / Mallett 2019',
        d: '光谱上采样算法。Hanatos 走色度→可见轨迹 LUT，宽色域更稳；Mallett 用三条基函数，快但对 sRGB 外的输入更敏感。' },
      { k: 'film', n: 'Stock', r: '20 种负片 / 反转片',
        d: '决定感光曲线、染料光谱、颗粒默认值与卤化强度。换 Stock 是最"换胶片"的一步。' },
      { k: 'filmFormat', n: 'Film Format', r: '8 / S8 / 16 / S16 / 35 / S35 / 65 / 70',
        d: '物理片窗尺寸。它不改变输出分辨率，而是改变"一个像素覆盖多少平方微米的胶片"，因此直接影响颗粒与光晕的物理尺度。' },
      { k: 'filmPushPullMode', n: 'Push / Pull Mode', r: 'Standard / Experimental',
        d: 'Standard 用 ECN-2 显影时间比例改斜率；Experimental 额外按通道、按影调区域扭曲并加入层间耦合。' },
      { k: 'filmPushPullStops', n: 'Film Push / Pull Stops', r: '−2 – +2',
        d: '推/拉显影量。正数推：反差更硬、有效感光度更高（暗部更早离开趾部），同时亮部更早压进肩部。映射到 150/180/220/280 秒的真实 ECN-2 时间。' },
      { k: 'negativeBleachBypassAmount', n: 'Negative Bleach Bypass', r: '0 – 1（开发中）',
        d: '负片漂白不足，保留银盐。结果：密度更高、黑色更实、彩度下降，接近 ENR 工艺。官方标注为开发中。' },
      { k: 'negativeLeucoCyanCoupling', n: 'Leuco-Cyan Coupling', r: '0 – 2',
        d: '负片漂白旁路时青染料的额外损失量。1.0 是物理锚定值，一般不用动。' },
      { k: 'filmExposureEv', n: 'Exposure EV', r: '−8 – +8',
        d: '胶片曝光补偿。+1 让底片多收一倍光，等同于降 ISO 拍摄。会同时改变颗粒与光晕手感。' },
      { k: 'autoExposure', n: 'Auto Exposure', r: 'bool',
        d: '测光后自动补偿胶片曝光，把场景亮度拉回参考。快速起手有用，但不利于锁定 look。' },
      { k: 'autoExposureMethod', n: 'Auto Exposure Meter', r: 'Center weighted / Median',
        d: '自动曝光的测光方式。中心加权更接近真实相机；中位数对大面积高光/阴影更稳。' },
      { k: 'filmGamma', n: 'Gamma', r: '0.1 – 2.0',
        d: '特性曲线斜率缩放。>1 更硬（曲线变陡），<1 更平。它不是显示 Gamma，是化学反应的反差。' }
    ]
  },
  {
    id: 'printGroup', name: 'Print', zh: '印片',
    params: [
      { k: 'paper', n: 'Paper', r: '7 种相纸 / 印片胶片',
        d: '相纸决定最终反差、色彩与黑位。Endura 系是柔和负片纸，2383 是电影印片用的正片。' },
      { k: 'printTiming', n: 'Print Timing', r: 'Filtered Enlarger / Printer Density',
        d: '两种印片计时模型。Filtered 用二向色滤片的光谱透过率；Printer Density 用学院印片密度（APD）响应率，更接近配光表工作流。' },
      { k: 'printPushPullStops', n: 'Print Push / Pull Stops', r: '−2 – +2',
        d: '相纸显影推拉。简化映射为 <code>2^(stops·0.25)</code> 的反差缩放，只作用在相纸，不影响负片。' },
      { k: 'printBleachBypassAmount', n: 'Print Bleach Bypass', r: '0 – 1（开发中）',
        d: '相纸侧保留银盐。比负片侧旁路更"脏"，黑位更闷。官方标注为开发中。' },
      { k: 'printExposureEv', n: 'Exposure EV', r: '−5 – +5',
        d: '放大机曝光。负片已经定死了，这里只改"印多亮"。适合在底片正确的前提下整体提亮/压暗。' },
      { k: 'printGamma', n: 'Gamma', r: '0.1 – 2.0',
        d: '相纸特性曲线斜率缩放。和 Print Push/Pull 是乘法叠加关系。' },
      { k: 'printShadowShape', n: 'Shadow Shape', r: '−1 – 1',
        d: '通过相纸响应塑造暗部。正值"打开"暗部，同时保持纸黑与纸白端点不动。' },
      { k: 'printHighlightShape', n: 'Highlight Shape', r: '−1 – 1',
        d: '塑造亮部。负值让高光更柔和、肩部更收。' },
      { k: 'filterC', n: 'C Filter', r: '0 – 120',
        d: '青色滤片量。它挡红光 → 相纸收到的红光变少 → 品红染料生成变少 → 印出来偏暖偏红。这是"减红"，最终观感与直觉相反是因为负片是反转的。' },
      { k: 'filterMShift', n: 'M Filter Shift', r: '−60 – 60',
        d: '相对中性平衡的品红偏移。它挡绿光，绿染料变少，画面偏绿。UI 上写的是「加品红」，观感却是偏绿，与 C 同一套反转逻辑。' },
      { k: 'filterYShift', n: 'Y Filter Shift', r: '−60 – 60',
        d: '相对中性平衡的黄色偏移。它挡蓝光 → 蓝染料变少 → 画面偏蓝。' },
      { k: 'preflashExposure', n: 'Preflash Exposure', r: '0 – 1',
        d: '在影像曝光之前给相纸一次均匀弱曝光。相纸的趾部在高光端，所以它恢复的是高光层次、柔化纯白，不是抬暗部。同时会轻微整体提亮。' },
      { k: 'preflashMFilterShift', n: 'Preflash M Filter Shift', r: '−60 – 60',
        d: '只作用于预闪的品红滤色，可让抬起的暗部带一点色彩倾向。' },
      { k: 'preflashYFilterShift', n: 'Preflash Y Filter Shift', r: '−60 – 60',
        d: '只作用于预闪的黄色滤色。' },
      { k: 'printerLightR', n: 'Printer Point R', r: '−24 – 24',
        d: '红通道配光点，单位 1/12 档。缩放 <code>2^(points/12)</code>。' },
      { k: 'printerLightG', n: 'Printer Point G', r: '−24 – 24', d: '绿通道配光点。' },
      { k: 'printerLightB', n: 'Printer Point B', r: '−24 – 24', d: '蓝通道配光点。' },
      { k: 'printerLightsGang', n: 'Gang Printer Points', r: 'bool',
        d: '三通道联动为同一个值。快速改整体亮度。' },
      { k: 'printerLightsGroup', n: 'Group Printer Points', r: 'bool',
        d: '保持三通道偏移量，一起同向移动。等效于"整体曝光 + 保留偏色"。' },
      { k: 'printerLightCalibration', n: 'Printer Point Calibration', r: 'bool',
        d: '应用生成的中性 APD 校准偏移。关掉可使用原始配光值。' }
    ]
  },
  {
    id: 'couplerGroup', name: 'DIR Couplers', zh: 'DIR 耦合',
    params: [
      { k: 'dirAmount', n: 'Amount', r: '0 – 2',
        d: '总强度。0 完全旁路；1.0 是参考强度。增大后色彩更分离、局部反差更强。' },
      { k: 'dirDiffusionUm', n: 'Diffusion um', r: '0 – 100 µm',
        d: '抑制物的横向扩散距离。越大影响范围越广，细节处的抑制越"糊"。' },
      { k: 'dirDiffusionTailUm', n: 'Tail um', r: '0 – 1000 µm',
        d: '长指数尾的扩散距离，模拟大范围晕染。' },
      { k: 'dirDiffusionTailWeight', n: 'Tail Weight', r: '0 – 1',
        d: '高斯核与指数尾的混合比例。' },
      { k: 'dirInhibitionSameLayer', n: 'Same-Layer Inhibition', r: '0 – 2',
        d: '同层抑制强度，主要塑造每层的局部反差。' },
      { k: 'dirInhibitionInterlayer', n: 'Interlayer Inhibition', r: '0 – 2',
        d: '层间抑制强度，主要塑造色彩分离与饱和度。' },
      { k: 'dirGammaSameLayerRgb', n: 'Same-Layer Gamma RGB', r: '0 – 1 ×3',
        d: '红/绿/蓝三个供体层的同层抑制系数。默认 0.336 / 0.319 / 0.273。' },
      { k: 'dirGammaRToGb', n: 'R → G/B Gamma', r: '0 – 1 ×2',
        d: '红层作为供体时，抑制绿层与蓝层的系数。' },
      { k: 'dirGammaGToRb', n: 'G → R/B Gamma', r: '0 – 1 ×2', d: '绿层的层间抑制系数。' },
      { k: 'dirGammaBToRg', n: 'B → R/G Gamma', r: '0 – 1 ×2', d: '蓝层的层间抑制系数。' },
      { k: 'dirCalibrateToStock', n: 'Calibrate to Stock', r: 'button',
        d: '恢复该 Stock 的 Python 对齐系数，并重新跟随 stock 校准。' }
    ]
  },
  {
    id: 'grainGroup', name: 'Grain', zh: '颗粒',
    params: [
      { k: 'grainEnabled', n: 'Enabled', r: 'bool', d: '开关颗粒合成。' },
      { k: 'grainModel', n: 'Model', r: 'Preview / Production / Grain Synthesis',
        d: 'Preview 快；Production 用分层染料云；Grain Synthesis 从随机布尔颗粒场重建密度，最像真胶片但很慢。' },
      { k: 'grainAmount', n: 'Amount', r: '0 – 2', d: '密度空间颗粒总强度。' },
      { k: 'grainSaturation', n: 'Saturation', r: '0 – 1',
        d: '把彩色颗粒向中性 CMY 混合。降低可得到更"单色"的颗粒。' },
      { k: 'grainSublayersEnabled', n: 'Sublayers', r: 'bool',
        d: '把颗粒拆到多层乳剂，密度结构更不匀、更自然。' },
      { k: 'grainSubLayerCount', n: 'Sub Layer Count', r: '1 – 8', d: 'Production 颗粒的乳剂分层数。' },
      { k: 'grainParticleAreaUm2', n: 'Particle Area um²', r: '0.01 – 5',
        d: '单颗粒子的平均面积（平方微米）。越小颗粒越细。' },
      { k: 'grainParticleScale', n: 'Particle Scale RGB', r: '×3',
        d: '红/绿/蓝三层的颗粒尺寸倍率。默认 1.2 / 1.0 / 2.5，蓝层最粗，这是真实乳剂的特性。' },
      { k: 'grainParticleScaleLayers', n: 'Layer Scale', r: '×3',
        d: '三个深度层的颗粒尺寸倍率。默认 6.0 / 1.0 / 0.4。' },
      { k: 'grainDensityMin', n: 'Density Min', r: '×3', d: '每通道颗粒密度的下限贡献。' },
      { k: 'grainUniformity', n: 'Uniformity RGB', r: '0 – 1 ×3',
        d: '均匀度。越高颗粒越匀；越低越容易结块（clumping）。' },
      { k: 'grainFinalBlurUm', n: 'Final Grain Blur', r: '0 – 25 µm',
        d: '35mm 等效的最终颗粒模糊量，会按所选画幅做物理补偿。' },
      { k: 'grainBlurDyeCloudsUm', n: 'Dye Cloud Blur um', r: '0 – 10',
        d: 'Production 模型里染料云本身的物理模糊。' },
      { k: 'grainMicroStructure', n: 'Micro Structure', r: '强度 / 波长 nm',
        d: '二维参数：X 是精细调制强度，Y 是结构波长。用于加入比颗粒更细的纹理。' },
      { k: 'grainSeed', n: 'Seed', r: '整数',
        d: '随机种子。固定后可重复；换值可换一张颗粒图案。' },
      { k: 'grainAnimate', n: 'Animate', r: 'bool',
        d: '让种子随时间变化，颗粒在帧间"游动"。关掉则是静态颗粒（有些风格化需求会关）。' }
    ]
  },
  {
    id: 'grainSynthesisGroup', name: 'Grain Synthesis', zh: '颗粒合成（高级）',
    params: [
      { k: 'grainSynthesisSize', n: 'Synthesis Size', r: '0.25 – 4',
        d: '颗粒粗细的简易倍率。' },
      { k: 'grainSynthesisAmount', n: 'Synthesis Amount', r: '0 – 3',
        d: '合成密度与已显影密度的混合量。0 保持原密度，1 完全用合成，>1 夸张偏离。' },
      { k: 'grainSynthesisSharpness', n: 'Synthesis Sharpness', r: '0.25 – 4',
        d: '蒙特卡洛观察滤波器宽度。越高越"锐"，但也越容易出噪点。' },
      { k: 'grainSynthesisQuality', n: 'Synthesis Quality', r: '0.25 – 4',
        d: '质量倍率，提高可减少蒙特卡洛噪声。' },
      { k: 'grainSynthesisSamples', n: 'Samples', r: '1 – 2048',
        d: '每像素蒙特卡洛采样数。这是这一组里最影响速度的参数。' },
      { k: 'grainSynthesisMeanRadiusUm', n: 'Mean Radius um', r: '0.05 – 10',
        d: '胶片平面上颗粒的平均物理半径（微米）。' },
      { k: 'grainSynthesisRadiusStdDevRatio', n: 'Radius StdDev Ratio', r: '0 – 1',
        d: '对数正态半径变化量。0 表示所有颗粒同样大。' },
      { k: 'grainSynthesisObservationSigmaUm', n: 'Observation Aperture Sigma um', r: '0 – 20',
        d: '蒙特卡洛估计器用的高斯观察孔径。' },
      { k: 'grainSynthesisCellSizeRatio', n: 'Cell Size Ratio', r: '0.25 – 2',
        d: '泊松分区格子相对平均半径的大小。越小单格颗粒越少但扫描格数更多。' },
      { k: 'grainSynthesisMaxRadiusQuantile', n: 'Max Radius Quantile', r: '0.95 – 0.9999',
        d: '截断对数正态颗粒的半径分位数，保证局部查找有限。' },
      { k: 'grainSynthesisCoverageEpsilon', n: 'Coverage Epsilon', r: '1e−6 – 0.01',
        d: '覆盖率转密度时的数值下限，避免接近全遮盖时数值爆掉。' },
      { k: 'grainSynthesisMaxGrainsPerCell', n: 'Max Grains Per Cell', r: '1 – 128',
        d: '每格最多生成的颗粒数，用来保证 GPU 开销可预测。' },
      { k: 'grainSynthesisRadiusScale', n: 'Radius Scale RGB', r: '×3', d: '三通道半径倍率。' },
      { k: 'grainSynthesisLayerScale', n: 'Layer Scale', r: '×3', d: '三个深度层的半径倍率。' },
      { k: 'grainSynthesisLayered', n: 'Layered', r: 'bool',
        d: '每层用各自的层密度曲线生成独立颗粒场。' }
    ]
  },
  {
    id: 'halationGroup', name: 'Halation', zh: '卤化',
    params: [
      { k: 'halationEnabled', n: 'Enabled', r: 'bool', d: '开关近乳剂散射与片基背反射。' },
      { k: 'scatterAmount', n: 'Scatter Amount', r: '0 – 2',
        d: '近乳剂散射强度。发生在长距离反射之前，是"紧"的那一层光晕。' },
      { k: 'scatterScale', n: 'Scatter Scale', r: '0 – 4', d: '散射半径倍率。' },
      { k: 'halationAmount', n: 'Amount', r: '0 – 4', d: '片基背反射的强度，也就是常说的 halation。' },
      { k: 'halationScale', n: 'Scale', r: '0 – 4', d: '卤化半径倍率。' },
      { k: 'halationStrength', n: 'Strength RGB', r: '×3',
        d: '各通道回光的权重。默认 0.05 / 0.015 / 0，所以卤化几乎纯红。' },
      { k: 'halationBoostEv', n: 'Boost EV', r: '0 – 20',
        d: '在做扩散/散射/卤化之前临时提高高光曝光。用于让弱高光也能触发可见光晕。' },
      { k: 'halationBoostRange', n: 'Boost Range', r: '0 – 1',
        d: '提升从保护阈值往上爬升的快慢。' },
      { k: 'halationProtectEv', n: 'Protect EV', r: '0 – 10',
        d: '中灰以上多少档之内不参与高光提升，保护肤色。' }
    ]
  },
  {
    id: 'diffusionGroup', name: 'Diffusion', zh: '扩散滤镜',
    params: [
      { k: 'cameraDiffusionEnabled', n: 'Camera Enabled', r: 'bool',
        d: '在胶片曝光前加扩散，等效于镜头前装滤镜。会改变底片收到的光。' },
      { k: 'printDiffusionEnabled', n: 'Print Enabled', r: 'bool',
        d: '在印片路径上加扩散，等效于放大机上的柔光。负片已经存在，只改变印出来的样子。' },
      { k: 'cameraDiffusionFamily', n: 'Camera Family', r: 'Glimmerglass / Black Pro-Mist / Pro-Mist / CineBloom',
        d: '滤镜族。四族的 core/halo/bloom 半径与权重完全不同：Glimmerglass 偏紧致，CineBloom 偏大范围泛光。' },
      { k: 'cameraDiffusionStrength', n: 'Camera Strength', r: '0 – 2',
        d: '总强度。内部映射为偏转光子比例（0.1 → 0.75）。' },
      { k: 'cameraDiffusionSpatialScale', n: 'Camera Spatial Scale', r: '0 – 4', d: '整体半径倍率。' },
      { k: 'cameraDiffusionHaloWarmth', n: 'Camera Halo Warmth', r: '−1.5 – 1.5',
        d: '光晕的冷暖偏向。正值更暖。' },
      { k: 'cameraDiffusionCoreIntensity', n: 'Camera Core Intensity', r: '0 – 4', d: '紧贴高光的锐利光斑强度。' },
      { k: 'cameraDiffusionCoreSize', n: 'Camera Core Size', r: '0.1 – 4', d: '锐利光斑半径倍率。' },
      { k: 'cameraDiffusionHaloIntensity', n: 'Camera Halo Intensity', r: '0 – 4', d: '中等半径光晕强度。' },
      { k: 'cameraDiffusionHaloSize', n: 'Camera Halo Size', r: '0.1 – 4', d: '中等半径光晕尺寸。' },
      { k: 'cameraDiffusionBloomIntensity', n: 'Camera Bloom Intensity', r: '0 – 4', d: '大范围泛光强度。' },
      { k: 'cameraDiffusionBloomSize', n: 'Camera Bloom Size', r: '0.1 – 4', d: '大范围泛光尺寸。' }
    ]
  },
  {
    id: 'scannerGroup', name: 'Scanner', zh: '扫描仪',
    params: [
      { k: 'scannerEnabled', n: 'Enabled', r: 'bool', d: '开关扫描级校正与光学效果。' },
      { k: 'scannerWhiteCorrection', n: 'White Correction', r: 'bool',
        d: '把指定白电平映射到显示白。' },
      { k: 'scannerBlackCorrection', n: 'Black Correction', r: 'bool',
        d: '把指定黑电平映射到显示黑。' },
      { k: 'scannerWhiteLevel', n: 'White Level', r: '0 – 1', d: '被当作扫描白的输入电平。' },
      { k: 'scannerBlackLevel', n: 'Black Level', r: '0 – 1', d: '被当作扫描黑的输入电平。' },
      { k: 'glarePercent', n: 'Glare Percent', r: '0 – 0.2',
        d: '扫描光源在印片表面反射回来造成的污染量。会整体抬黑，是很典型的"扫描件感"。' },
      { k: 'glareRoughness', n: 'Glare Roughness', r: '0 – 4', d: '光晕场的空间随机性。' },
      { k: 'glareBlur', n: 'Glare Blur', r: '0 – 32 px', d: '光晕场的高斯模糊半径。' },
      { k: 'scannerMtf50LpMm', n: 'MTF50 lp/mm', r: '0 – 300',
        d: '扫描光学解析力。0 表示旁路模糊。数值越低，高频细节丢得越多。' },
      { k: 'scannerUnsharpRadiusUm', n: 'Unsharp Radius um', r: '0 – 100',
        d: 'USM 的胶片平面半径。' },
      { k: 'scannerUnsharpAmount', n: 'Unsharp Amount', r: '0 – 4',
        d: 'USM 强度。适度能找回被 MTF 抹掉的细节，过度会出现白边。' }
    ]
  },
  {
    id: 'manageGroup', name: 'Manage', zh: '管理',
    params: [
      { k: 'gpuRenderTiling', n: 'GPU Render Tiling', r: 'Full-frame / Experimental tiled',
        d: 'GPU 分块渲染。超大分辨率或显存不够时，分块更稳但略慢。' },
      { k: 'lutSize', n: 'LUT Size', r: '33 / 65',
        d: '导出 3D LUT 的立方体分辨率。65 质量更高，33 更快更小。' },
      { k: 'lutDestination', n: 'LUT Destination', r: 'User / Resolve / Nuke / Adobe / FCP',
        d: '导出路径预设。' },
      { k: 'exportLut', n: 'Export LUT', r: 'button',
        d: '导出 Display Out SDR 的纯色彩 LUT。RCM 与 HDR 模式下不可用（因为它们不是纯色彩映射）。' },
      { k: 'savePreset', n: 'Save Preset', r: 'button', d: '把当前设置存成带时间戳的预设文件。' },
      { k: 'copyParams', n: 'Copy Params', r: 'button', d: '把设置复制到系统剪贴板，可跨实例粘贴。' },
      { k: 'pasteParams', n: 'Paste Params', r: 'button', d: '从剪贴板应用设置。' },
      { k: 'saveDefaults', n: 'Set Defaults', r: 'button', d: '把当前设置存为新建实例的默认值。' },
      { k: 'resetDefaults', n: 'Reset Factory Defaults', r: 'button', d: '清除用户默认值并复位到出厂设置。' }
    ]
  }
];

/* ---------- 目标 → 该拧哪个参数 ---------- */
const ROUTES = [
  { goal: '整体亮一点', where: 'Print · Exposure EV', why: '底片已经对了，只是印得亮些。不改变颗粒与卤化手感。' },
  { goal: '整体亮一点，但想改颗粒', where: 'Film · Exposure EV', why: '等同降 ISO 拍，会让底片落在曲线不同位置。' },
  { goal: '反差更硬', where: 'Film Push/Pull → Print Push/Pull → Gamma', why: '先问"哪一段该变"。推显影改底片；推纸改印片；Gamma 是直接改斜率。' },
  { goal: '高光层次更多', where: 'Print · Preflash', why: '相纸趾部在高光端，预闪把那里撑开，纯白被柔化下来。注意它会轻微提亮整幅。' },
  { goal: '暗部细节多一些', where: 'Print · Shadow Shape（正）', why: 'Shadow Shape 直接改纸响应的暗部曲率，端点不动。' },
  { goal: '高光柔和些', where: 'Print · Highlight Shape（负值）', why: '作用在纸的肩部，保留纸白。' },
  { goal: '画面偏暖', where: 'Print · C Filter（加）', why: '青滤片挡红 → 印片红层欠曝 → 最终偏红。M/Y 同理，都是"减色 → 反相"的观感。' },
  { goal: '画面偏冷', where: 'Print · Y Filter Shift（正）', why: '黄滤片挡蓝 → 蓝层欠曝 → 画面偏蓝。' },
  { goal: '颜色更"分离"/更厚', where: 'DIR Couplers · Amount', why: '层间抑制增强，色彩分离更明显，比加饱和度自然。' },
  { goal: '去饱和、黑更实', where: 'Negative / Print Bleach Bypass', why: '保留银盐，彩度下降、黑位更闷。' },
  { goal: '颗粒更粗', where: 'Film Format 变小 / Grain Amount ↑ / Particle Area ↑', why: '换 16mm 最物理（同一颗粒占更大画面比例）；不动画幅就加大粒子面积。' },
  { goal: '颗粒更细', where: 'Film Format 变大 / Particle Area ↓', why: '换 65mm，或在 35mm 下把粒子面积调小。' },
  { goal: '高光有橙红光晕', where: 'Halation · Amount', why: '片基背反射，红光为主。想更宽就加 Scale。' },
  { goal: '画面柔一点但不是糊', where: 'Diffusion · Camera/Print', why: '相机侧改底片，印片侧改印相。前者更"进片子"。' },
  { goal: '更像扫描件', where: 'Scanner · Glare / MTF50', why: '光晕污染 + 降低解析力，是最快出"扫描味"的组合。' }
];
