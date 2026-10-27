"""ComfyUI-AccelSwitch: 顶栏一键切换全局注意力加速后端（ComfyUI 0.43）

不改动任何 ComfyUI 核心文件，纯启动补丁 + HTTP 接口：

  1. 切换时重写 comfy.ldm.modules.attention 的 optimized_attention /
     optimized_attention_masked 全局变量（影响所有 optimized_attention_for_device
     调用方：CLIP、图像编码器等，调用时读取，即时生效）；
  2. 对已加载模型调用核心自带 ModelPatcher.set_model_optimized_attention
     （写入 model_options["transformer_options"]["optimized_attention_override"]）。
     该覆盖在 attention.wrap_attn 中每次注意力调用都最先检查，对已加载模型即时生效；
  3. 钩住 model_management.LoadedModel.__init__，之后新加载的模型自动带上覆盖；
  4. 工作流内节点自带的覆盖（XB sage 节点 / T8 / ModelAttentionBackend）优先级更高：
     本模块只替换自己注入的覆盖（_accel_switch_owned 标记），不碰节点设置的。

选择持久化到 state.json，重启 ComfyUI 后自动恢复。
API：GET  /accel_switch              查询状态与可用后端
     POST /accel_switch {"backend": k} 切换（k=auto 恢复启动默认）
"""

import functools
import json
import logging
import os
import threading

_LOG = logging.getLogger("AccelSwitch")
_DIR = os.path.dirname(os.path.abspath(__file__))
_STATE_FILE = os.path.join(_DIR, "state.json")
_LOCK = threading.Lock()

# 与 comfy.ldm.modules.attention.REGISTERED_ATTENTION_FUNCTIONS 的 key 对应；
# auto 为虚拟项：恢复启动参数（--use-ck-attention 等）决定的默认后端。
BACKENDS = {
    "auto":               {"label": "启动默认",           "short": "默认",      "desc": "恢复启动参数决定的默认后端"},
    "comfy_kitchen_int8": {"label": "Comfy Kitchen INT8", "short": "Kitchen",   "desc": "comfy-kitchen INT8 注意力（--use-ck-attention 同款）"},
    "sage":               {"label": "SageAttention",      "short": "Sage",      "desc": "sageattention 内核（XB sage 节点同款）"},
    "sage3":              {"label": "SageAttention3",     "short": "Sage3",     "desc": "SageAttention3（Blackwell 优化）"},
    "flash":              {"label": "FlashAttention",     "short": "Flash",     "desc": "FlashAttention-2"},
    "xformers":           {"label": "xFormers",           "short": "xFormers",  "desc": "xFormers memory-efficient attention"},
    "pytorch":            {"label": "PyTorch (SDPA)",     "short": "PyTorch",   "desc": "PyTorch 原生 scaled_dot_product_attention"},
    "sub_quad":           {"label": "SubQuadratic",       "short": "SubQuad",   "desc": "ComfyUI 默认子二次优化"},
    "split":              {"label": "Split Cross",        "short": "Split",     "desc": "split cross attention（省显存）"},
}

_OWNED = "_accel_switch_owned"
_LABEL = "_accel_switch_label"

_current = "auto"


# ---------------------------------------------------------------- 基础工具

def _attn():
    import comfy.ldm.modules.attention as attn
    return attn


def _registry():
    return _attn().REGISTERED_ATTENTION_FUNCTIONS


def _startup_function():
    """启动时的默认后端函数（本包导入时捕获的原对象，auto 用它还原）。"""
    attn = _attn()
    fn = getattr(attn, "_accel_switch_startup_fn", None)
    if fn is None:
        fn = attn.optimized_attention
        attn._accel_switch_startup_fn = fn
    return fn


def _label(key):
    return BACKENDS.get(key, {}).get("label", key)


def _resolve(key):
    """key -> 可调用注意力函数；不可用返回 None。"""
    if key == "auto":
        return _startup_function()
    return _registry().get(key)


def _available():
    """可用后端 key 列表（注册表中真实存在的 + auto），保持 BACKENDS 顺序。"""
    reg = _registry()
    keys = [k for k in BACKENDS if k == "auto" or k in reg]
    return keys


# ---------------------------------------------------------------- 模型覆盖

def _inject(patcher, fn, label):
    """给单个 ModelPatcher 注入本模块的覆盖；节点自带覆盖不碰。"""
    try:
        to = patcher.model_options.setdefault("transformer_options", {})
        existing = to.get("optimized_attention_override")
        if existing is not None and not getattr(existing, _OWNED, False):
            return False  # 工作流节点自己的覆盖，优先级更高
        patcher.set_model_optimized_attention(fn)
        ov = patcher.model_options["transformer_options"]["optimized_attention_override"]
        setattr(ov, _OWNED, True)
        setattr(ov, _LABEL, label)
        return True
    except Exception as e:
        _LOG.warning("注入注意力覆盖失败: %s", e)
        return False


def _remove_owned(patcher):
    try:
        to = patcher.model_options.get("transformer_options") or {}
        ov = to.get("optimized_attention_override")
        if ov is not None and getattr(ov, _OWNED, False):
            del to["optimized_attention_override"]
            return True
    except Exception as e:
        _LOG.warning("移除注意力覆盖失败: %s", e)
    return False


def _walk_loaded(apply_fn):
    import comfy.model_management as mm
    n = 0
    try:
        for lm in list(mm.current_loaded_models):
            patcher = lm.model
            if patcher is None:
                continue
            if apply_fn(patcher):
                n += 1
    except Exception as e:
        _LOG.warning("遍历已加载模型失败: %s", e)
    return n


def _install_load_hook():
    """新加载的模型自动带上当前覆盖（auto 时不注入）。"""
    import comfy.model_management as mm
    if getattr(mm.LoadedModel.__init__, "_accel_switch_hooked", False):
        return
    orig = mm.LoadedModel.__init__

    @functools.wraps(orig)
    def patched_init(self, model):
        orig(self, model)
        if _current != "auto":
            fn = _resolve(_current)
            if fn is not None:
                _inject(model, fn, _label(_current))

    patched_init._accel_switch_hooked = True
    mm.LoadedModel.__init__ = patched_init


def _install_guider_hook():
    """CFGGuider 创建时注入。

    关键时序：CFGGuider.sample() 开头会 clone model_options（深拷贝嵌套 dict），
    而模型可能是懒加载的（prepare_sampling 时才 load_models_gpu，晚于 clone）。
    若只在模型加载时注入，当次运行会错过。在 guider 创建时注入 patcher 的
    model_options，可保证 clone 时覆盖已在（无论模型是否已加载）。
    工作流节点自带的覆盖（在 clone 上设置）优先，不碰。
    """
    import comfy.samplers
    if getattr(comfy.samplers.CFGGuider.__init__, "_accel_switch_hooked", False):
        return
    orig = comfy.samplers.CFGGuider.__init__

    @functools.wraps(orig)
    def patched_init(self, model_patcher):
        orig(self, model_patcher)
        if _current != "auto":
            fn = _resolve(_current)
            if fn is not None:
                _inject(model_patcher, fn, _label(_current))

    patched_init._accel_switch_hooked = True
    comfy.samplers.CFGGuider.__init__ = patched_init


# ---------------------------------------------------------------- 切换

def apply(key, persist=True):
    """应用切换。返回 (ok, message)。"""
    global _current
    if key not in BACKENDS:
        return False, "未知后端: %r" % (key,)
    with _LOCK:
        fn = _resolve(key)
        if fn is None:
            return False, "后端 %s 当前不可用（未安装或硬件不支持）" % _label(key)
        attn = _attn()
        if key == "auto":
            fn = _startup_function()
            attn.optimized_attention = fn
            attn.optimized_attention_masked = fn
            n = _walk_loaded(_remove_owned)
            _current = "auto"
            if persist:
                _save()
            _LOG.info("已恢复启动默认后端（%d 个已加载模型的覆盖已移除）", n)
            return True, "已恢复启动默认后端"
        attn.optimized_attention = fn
        attn.optimized_attention_masked = fn
        n = _walk_loaded(lambda p: _inject(p, fn, _label(key)))
        _current = key
        if persist:
            _save()
        _LOG.info("已切换全局注意力后端: %s（%d 个已加载模型已更新，后续加载自动生效）", _label(key), n)
        return True, "已切换到 %s" % _label(key)


def _save():
    try:
        with open(_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"backend": _current}, f)
    except Exception as e:
        _LOG.warning("保存 state.json 失败: %s", e)


def _load():
    try:
        with open(_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("backend", "auto")
    except Exception:
        return "auto"


def state_payload():
    keys = _available()
    return {
        "current": _current,
        "available": {k: BACKENDS[k] for k in keys},
        "startup_default": _label("auto"),
    }


# ---------------------------------------------------------------- HTTP 接口

def _register_routes():
    try:
        from server import PromptServer
    except Exception as e:
        _LOG.warning("PromptServer 不可用，顶栏切换接口未注册: %s", e)
        return
    from aiohttp import web

    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        _LOG.warning("PromptServer.instance 尚未创建，顶栏切换接口未注册（重启后生效）")
        return
    routes = instance.routes
    if getattr(routes, "_accel_switch_registered", False):
        return

    @routes.get("/accel_switch")
    async def get_state(request):
        return web.json_response(state_payload())

    @routes.post("/accel_switch")
    async def set_state(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        key = data.get("backend")
        ok, msg = apply(key)
        if not ok:
            return web.json_response({"error": msg}, status=400)
        return web.json_response({"ok": True, "message": msg, **state_payload()})

    routes._accel_switch_registered = True


# ---------------------------------------------------------------- 启动

def _install():
    _startup_function()  # 导入时立即捕获启动默认，避免被后续切换污染
    saved = _load()
    if saved and saved != "auto":
        ok, msg = apply(saved, persist=False)
        if ok:
            _LOG.info("已从 state.json 恢复上次选择: %s", _label(saved))
        else:
            _LOG.warning("恢复上次选择失败（%s），保持启动默认", msg)
    _install_load_hook()
    _install_guider_hook()
    _register_routes()
    _LOG.info("顶栏加速切换已就绪 | 当前: %s | 可用: %s",
              _label(_current), ", ".join(_label(k) for k in _available()))


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./js"

_install()
