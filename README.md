# spektrafilm 拆解手册

一个单页交互式教学网站，拆解 [spektrafilm OFX](https://github.com/chaert-s/spektrafilm-ofx) 在 DaVinci Resolve 里的成像原理。

页面里跑着一个微型的 spektrafilm 实现：从线性 RGB 出发，经光谱上采样、乳剂曝光、特性曲线显影、光学印片、扫描回 RGB，全流程可交互调参。

## 为什么不是 LUT

普通 LUT 把一个 RGB 三元组映射成另一个。spektrafilm 把你的 RGB 当作场景光的一条线索，还原成连续光谱，穿过胶片三层乳剂得到染料密度，再用光穿过密度印到相纸上，最后扫描回 RGB。

中间流动的是物理量：`曝光 → log 曝光 → CMY 密度 → 光谱密度 → 透射光 → 显示 RGB`。

## 内容结构

| 章节 | 内容 |
|---|---|
| 01 成像链 | 八站串联关系 + Beer–Lambert 透视率演示 |
| 02 光谱 | 同色异谱问题、三种上采样算法对比 |
| 03 显影 | 真实 Portra 400 特性曲线、Push/Pull 与 ECN-2 显影时间 |
| 04 印片 | 负片作为可变减光器、CMY 滤色、Printer Points、预闪 |
| 05 质感 | 粒子统计模型、卤化、扩散滤镜 |
| 06 扫描 | 密度 → XYZ → RGB、眩光、MTF、USM |
| 07 落地 | Resolve 节点树位置、目标→参数对照表 |
| 08 手感 | 11 个参数的前后对比实验室 |
| 09 参数 | 完整参数索引，可搜索 |

## 数据来源

曲线、染料光谱、感光曲线与中性滤色值全部取自 [spektrafilm-ofx](https://github.com/chaert-s/spektrafilm-ofx) 仓库的 `Resources/data/profiles` 与 `neutral_print_filters.json`，公式与阶段顺序对照[官方技术白皮书](https://spektrafilm.114c.de/technical/)。

包含 6 种底片（Portra 400 / Ultramax 400 / Vision3 500T / Ektar 100 / C200 / Kodachrome 64）与 3 种相纸。

## 关于精度

页面里的图像是**教学用近似实现**，为实时交互做了简化，数值不保证与插件逐位一致。真实插件在 GPU 上以 81 波长采样、2D 可见轨迹 LUT、多层粒子场与完整 DIR 耦合矩阵计算。

## 本地运行

不需要构建，也没有依赖。直接打开即可：

```sh
open index.html
```

或起一个静态服务：

```sh
python3 -m http.server 8000
```

## 许可与致谢

页面代码可自由使用。

spektrafilm 由 Andrea Volpato 与 Johannes Hanika 开发，以 GPL v3 发布。本页仅为教学解说，不包含插件本体。
