# ComfyUI-AccelSwitch

ComfyUI 顶栏补丁，四件事：

1. **顶栏一键切换全局注意力加速后端**（启动默认 / Kitchen INT8 / SageAttention / SageAttention3 / FlashAttention / xFormers / PyTorch / SubQuadratic / Split）
2. **顶栏整体缩放**（100% / 90% / 80% / 70% / 60% 五档可调，解决顶栏太占地方）
3. **工作流保存时快照 + 打开自动套用 + 一键恢复**（后端 + 缩放 + 所有节点参数）
4. **后端微基准**（固定合成形状的裸注意力计时，列出各后端该形状下的 kernel 耗时）

- 不注册任何工作流节点
- 不需要任何额外依赖（纯标准库 + ComfyUI 内部接口 + 原生前端组件）
- 不改动 ComfyUI 核心文件——**删掉整个文件夹即完全移除**

## 功能一：加速切换

顶栏出现一个闪电图标 + **当前后端简称徽章**的按钮（与「运行 ▾」同款 SplitButton）：

- **点主体**：按顺序循环切换后端
- **点 ▾**：弹出完整列表，✓ 为当前项；未安装/硬件不支持的后端会灰显，点了会提示不可用
- **悬停主体**：显示当前后端全名和快捷键说明
- **`Ctrl+Alt+A`**：循环切换后端；**`Ctrl+Alt+R`**：一键恢复快照（输入框内不会触发）

可选后端列表包含所有已知后端（由 ComfyUI 注意力注册表决定可用性），灰显项不可选。

### 切换机制（三条官方通道互补）

1. 重写 `comfy.ldm.modules.attention.optimized_attention / _masked` 全局——影响所有调用时读取该全局的路径（CLIP、图像编码器等），即时生效；
2. 对已加载模型调用核心自带 `ModelPatcher.set_model_optimized_attention`，写入 `optimized_attention_override`——`wrap_attn` 每次注意力调用最先检查它，对已加载模型即时生效（**包括 qwen_image 等捕获式导入的模型，这是唯一对它们有效的机制**）；
3. 钩住 `LoadedModel.__init__` + `CFGGuider.__init__`——之后新加载 / 懒加载的模型自动带上覆盖（guider 钩子是关键：`CFGGuider.sample()` 开头会深拷贝 model_options，晚于它的懒加载不能错过）。

**工作流内节点自带的覆盖优先**（XB sage / BlockCache-T8 / ModelAttentionBackend 等节点设的覆盖不碰、不受影响）。

选择存包目录下的 `state.json`，重启 ComfyUI 自动恢复。

## 功能二：顶栏缩放

同一个 ▾ 下拉菜单里有「顶栏缩放」档位（默认 80%）：

- 对整个顶栏（命令栏 + 队列 / 任务浮层）做 CSS zoom 等比缩小——布局级缩放，文字重新渲染不模糊
- 选择记在浏览器 localStorage，刷新 / 重启不丢，只影响你自己的浏览器
- 只在新版 Vue 前端（ComfyUI 0.4x）生效；老前端下静默不生效，不影响其他功能

## 功能三：保存时快照 / 一键恢复

每次你点 ComfyUI 的「保存工作流」，本插件会把那一刻的设置存一份快照到**服务端** `user/AccelSwitch/snapshots.json`（跟随 ComfyUI 用户目录，**换浏览器 / 清缓存都不丢**；浏览器 localStorage 只作兜底缓存）：

- **加速后端**：当时顶栏选的是哪个后端
- **顶栏缩放**：当时的缩放档位
- **所有节点参数**：每个节点的 widget 值（**含图像节点选的图**）、旁通状态（mode）、标题

下拉菜单里的 **「↺ 恢复上次保存的设置」** 一键把这三样一起还原到当前工作流：

- 节点按 ID 匹配，用 LiteGraph 官方 `node.configure()` 恢复参数（图像节点的图像能正确还原），只覆盖当前图里还存在的节点，**不会新建 / 删除节点或连线**
- 后端恢复走原有的切换接口（不可用时会提示并保持当前后端）
- 快照按工作流文件路径分别保存，菜单悬停提示里能看到是哪个文件、多少个节点
- **打开工作流时自动套用**该文件保存时的「后端 + 缩放」（节点参数仍来自工作流文件本身，不会被快照覆盖）
- 恢复完成会弹出可见的确认面板；`Ctrl+Alt+R` 快捷键同样能恢复

> 这个功能是「设置快照」，不是工作流版本管理；节点增删 / 连线变化请仍以 ComfyUI 自己的工作流文件为准——快照只负责把还存在的节点参数拧回保存时的值。快照服务端最多保留最近 30 个工作流。

## 功能四：后端微基准（注意：不是真实出图速度）

下拉菜单里有两个入口：

- **「⚡ 后端微基准（合成）」**：默认 2 次预热 + 5 次计时，**1024 token / 24 头 / 128 维 fp16**
- **「⚡ 微基准：Qwen 大形状」**：4096 token / 24 头 / 128 维 bf16，更贴近 Qwen Image 2.1 的注意力形状（显存占用更高）

后端逐个跑同一份合成 q/k/v 的裸注意力函数，然后：

- 按耗时排序，**同时写到两处**：① 屏幕右下角结果面板；② 服务端日志，搜 **`后端跑分`**（`user/comfyui.log` / 启动器控制台）
- 只直接调用注册表里的注意力函数，**不修改当前后端、不碰已加载模型**，跑完自动清缓存
- 需要 CUDA；不可用的后端单独标 error，不影响其他项
- 请求体可覆盖参数（含 dtype）：`{"warmup":2,"iters":5,"tokens":4096,"heads":24,"dim":128,"dtype":"bf16"}`

### 这个数字能说明什么、不能说明什么

**能**：同样形状下，哪个后端的内核本身更快（数字越小 = 该形状下裸内核越快）。

**不能**：它**不等于你工作流的真实出图速度**。负载是固定形状、无 mask 的随机张量，没有真实模型的注意力掩码、块缓存、量化权重布局、序列长度分布。

**形状一变，排名就会反转**。实测同一台机器：

| 形状 | xFormers | Kitchen INT8 |
|---|---|---|
| 256 token / 8 头 / 64 维（旧默认值） | **0.119ms**（最快） | 0.214ms |
| 1024 token / 24 头 / 128 维（新默认值） | 0.503ms | **0.223ms**（最快） |

**判断哪个后端对你更快，请以 AccelLog 的真实运行数据为准**：`[加速汇总]` 的采样耗时、`[节点耗时]`（日志搜这两个关键词）。

另外，如果你的工作流用 **Qwen T8 / XB sage / ModelAttentionBackend** 这类节点，它们自己就设置了注意力路由（例如 T8 的 `sage/kitchen 混合`），**顶栏切换会被这些节点覆盖、进不了采样主路径**——这时切换后端不改变出图速度，微基准排名更与你无关。从 `[加速日志]` 的「来源」一栏能看出这一刀到底是谁决定的。

## 安装

把本文件夹放到 ComfyUI 的 `custom_nodes/` 目录下，重启 ComfyUI：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/wqy0858/ComfyUI-AccelSwitch.git ComfyUI-AccelSwitch
```

或者：

- 用 ComfyUI-Manager 的「Install via Git URL」粘贴仓库地址
- 在 ComfyUI-Manager 的节点搜索里直接搜 **`accel`**（已上架 Comfy Registry），或命令行 `comfy node install accel-switch`

**安装后浏览器要硬刷新（Ctrl+Shift+R）**，否则前端 JS 不更新。

## HTTP API

```text
GET  /accel_switch                      → {"current": "...", "available": {...}, "all": {...含 available 标记}, "startup_default": "..."}
POST /accel_switch  {"backend": "sage"} → 切换并返回新状态（auto = 恢复启动默认）
POST /accel_switch_benchmark  {"tokens":4096,"dtype":"bf16"} → {"ok": true, "shape_desc": "...", "params": {...}, "results": [{"label": "...", "ms": 0.123}, ...]}
GET  /accel_switch_snapshots            → {"ok": true, "snapshots": {"workflows/xx.json": {...}, ...}}
POST /accel_switch_snapshots  {"file": "workflows/xx.json", "snapshot": {...}} → 写入快照（最多保留 30 个）
```

## 已知边界

- VAE 注意力不跟随切换（保持启动时的后端，VAE 解码耗时占比极小）
- 不走 CFGGuider 的自定义采样循环（部分视频类 wrapper）不生效
- CLIP 文本编码器注意力跟随全局切换

## 兼容性

- 开发验证环境：ComfyUI 0.43 + 前端 1.59.11（按钮、快照钩子与缩放按新版前端设计并实测）
- 老版本前端：切换按钮仍尝试挂载（有兜底路径），顶栏缩放不生效
- 接口对不上时安静降级（打警告行），不会导致 ComfyUI 启动失败

## 卸载

删除本文件夹，重启 ComfyUI。

## License

MIT
