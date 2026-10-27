# ComfyUI-AccelSwitch

ComfyUI 顶栏补丁，两件事：

1. **顶栏一键切换全局注意力加速后端**（启动默认 / Kitchen INT8 / SageAttention / SageAttention3 / FlashAttention / xFormers / PyTorch / SubQuadratic / Split）
2. **顶栏整体缩放**（100% / 90% / 80% / 70% / 60% 五档可调，解决顶栏太占地方）

- 不注册任何工作流节点
- 不需要任何额外依赖（纯标准库 + ComfyUI 内部接口 + 原生前端组件）
- 不改动 ComfyUI 核心文件——**删掉整个文件夹即完全移除**

## 功能一：加速切换

顶栏出现一个闪电图标按钮（与「运行 ▾」同款 SplitButton）：

- **点主体**：按顺序循环切换后端
- **点 ▾**：弹出完整列表，✓ 为当前项
- **悬停主体**：显示当前后端全名

可选后端列表中只有你机子真正装了的后端才会出现（由 ComfyUI 注意力注册表决定）。

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
GET  /accel_switch                    → {"current": "...", "available": {...}, "startup_default": "..."}
POST /accel_switch  {"backend": "sage"} → 切换并返回新状态（auto = 恢复启动默认）
```

## 已知边界

- VAE 注意力不跟随切换（保持启动时的后端，VAE 解码耗时占比极小）
- 不走 CFGGuider 的自定义采样循环（部分视频类 wrapper）不生效
- CLIP 文本编码器注意力跟随全局切换

## 兼容性

- 开发验证环境：ComfyUI 0.43 + 前端 1.57.4（按钮与缩放按新版前端设计）
- 老版本前端：切换按钮仍尝试挂载（有兜底路径），顶栏缩放不生效
- 接口对不上时安静降级（打警告行），不会导致 ComfyUI 启动失败

## 卸载

删除本文件夹，重启 ComfyUI。

## License

MIT
