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
工作流设置快照持久化到 user/AccelSwitch/snapshots.json（跟随 ComfyUI 用户目录，
跨浏览器 / 清缓存都不丢）。

API：GET  /accel_switch                  查询状态与可用后端
     POST /accel_switch {"backend": k}   切换（k=auto 恢复启动默认）
     POST /accel_switch_benchmark        跑分（可用后端耗时排序，不改当前选择）
     GET  /accel_switch_snapshots        读取全部工作流快照
     POST /accel_switch_snapshots {"file":..., "snapshot":...}  写入一个快照
     GET  /accel_switch_presets?workflow=...  读取该工作流的参数模板
     POST /accel_switch_presets {"workflow":..., "action":"save"|"delete", "name":..., "preset":...}
"""

import functools
import json
import logging
import os
import threading
import time

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


# ---------------------------------------------------------------- 工作流快照（服务端）

def _snapshot_file():
    """快照文件路径：跟随 ComfyUI 用户目录，跨浏览器 / 清缓存都不丢。"""
    try:
        import folder_paths
        user_dir = folder_paths.get_user_directory()
    except Exception:
        user_dir = os.path.join(os.path.dirname(_DIR), "user")  # 兜底：ComfyUI/user
    snap_dir = os.path.join(user_dir, "AccelSwitch")
    try:
        os.makedirs(snap_dir, exist_ok=True)
    except Exception as e:
        _LOG.warning("创建快照目录失败: %s", e)
    return os.path.join(snap_dir, "snapshots.json")


def _snapshots_load():
    """读取全部工作流快照 -> {file: snapshot}。"""
    with _LOCK:
        try:
            with open(_snapshot_file(), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except Exception as e:
            _LOG.warning("读取快照失败: %s", e)
            return {}


def _snapshots_save(snapshots):
    """把全部快照写回服务端（原子替换，防半截文件）。"""
    path = _snapshot_file()
    tmp = path + ".tmp"
    with _LOCK:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(snapshots, f, ensure_ascii=False)
            os.replace(tmp, path)
            return True
        except Exception as e:
            _LOG.warning("保存快照失败: %s", e)
            return False


def _snapshot_put(file, snapshot):
    """写入单个工作流的快照，返回是否成功。"""
    if not isinstance(file, str) or not file.startswith("workflows/") or not file.endswith(".json"):
        return False, "非法的快照文件标识"
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("nodes"), list):
        return False, "快照格式错误（缺少 nodes）"
    snapshots = _snapshots_load()
    snapshot = dict(snapshot)
    snapshot["savedAt"] = snapshot.get("savedAt") or (time.time() * 1000)
    snapshot["file"] = file
    # 限制体积：只保留最近 30 个工作流的快照，避免无限增长
    snapshots[file] = snapshot
    if len(snapshots) > 30:
        oldest = sorted(snapshots, key=lambda k: snapshots[k].get("savedAt", 0))[:len(snapshots) - 30]
        for k in oldest:
            snapshots.pop(k, None)
    if not _snapshots_save(snapshots):
        return False, "写入快照文件失败"
    return True, "快照已保存到服务端"


# ---------------------------------------------------------------- 常用参数模板（服务端）

def _preset_file():
    """模板文件路径：与快照同目录，跨浏览器 / 清缓存都不丢。"""
    try:
        import folder_paths
        user_dir = folder_paths.get_user_directory()
    except Exception:
        user_dir = os.path.join(os.path.dirname(_DIR), "user")
    preset_dir = os.path.join(user_dir, "AccelSwitch")
    try:
        os.makedirs(preset_dir, exist_ok=True)
    except Exception as e:
        _LOG.warning("创建模板目录失败: %s", e)
    return os.path.join(preset_dir, "presets.json")


def _presets_load_all():
    """读取 -> {workflowKey: {模板名: 模板}}。

    模板按工作流隔离。旧版（未按工作流区分）的数据归档到 __legacy__，
    不在任何工作流里显示，避免张冠李戴。
    """
    with _LOCK:
        try:
            with open(_preset_file(), "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return {}
        except Exception as e:
            _LOG.warning("读取参数模板失败: %s", e)
            return {}
    if not isinstance(data, dict):
        return {}
    if data.get("__v") == 2 and isinstance(data.get("workflows"), dict):
        return {k: v for k, v in data["workflows"].items() if isinstance(v, dict)}
    legacy = {k: v for k, v in data.items()
              if isinstance(v, dict) and isinstance(v.get("values"), list)}
    return {"__legacy__": legacy} if legacy else {}


def _presets_save_all(by_workflow):
    path = _preset_file()
    tmp = path + ".tmp"
    with _LOCK:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"__v": 2, "workflows": by_workflow}, f, ensure_ascii=False)
            os.replace(tmp, path)
            return True
        except Exception as e:
            _LOG.warning("保存参数模板失败: %s", e)
            return False


def _valid_workflow_key(key):
    return isinstance(key, str) and 0 < len(key) <= 300 and "\x00" not in key


def _valid_preset_name(name):
    if not isinstance(name, str):
        return False
    name = name.strip()
    return bool(name) and len(name) <= 40 and not any(
        c in name for c in ("/", "\\", "..", "\x00")
    )


def _presets_for(workflow):
    """某个工作流的模板（不含 __legacy__）。"""
    if not _valid_workflow_key(workflow):
        return {}
    return _presets_load_all().get(workflow, {})


def _preset_put(workflow, name, preset):
    if not _valid_workflow_key(workflow):
        return False, "工作流标识非法"
    if not _valid_preset_name(name):
        return False, "模板名非法（1~40 字符，不能含路径分隔符）"
    if not isinstance(preset, dict) or not isinstance(preset.get("values"), list):
        return False, "模板格式错误（缺少 values）"
    name = name.strip()
    by_workflow = _presets_load_all()
    bucket = by_workflow.setdefault(workflow, {})
    p = dict(preset)
    p["savedAt"] = p.get("savedAt") or (time.time() * 1000)
    p["name"] = name
    bucket[name] = p
    # 每个工作流最多 20 个，按保存时间淘汰最旧的
    if len(bucket) > 20:
        oldest = sorted(bucket, key=lambda k: bucket[k].get("savedAt", 0))[:len(bucket) - 20]
        for k in oldest:
            bucket.pop(k, None)
    if not _presets_save_all(by_workflow):
        return False, "写入模板文件失败"
    _LOG.info("已保存参数模板: [%s] %s（%d 项参数，%d 个旁通/忽略节点）",
              workflow, name, len(p.get("values") or []),
              len([m for m in (p.get("modes") or []) if isinstance(m, dict) and m.get("mode")]))
    return True, "模板已保存到服务端"


def _preset_move(src, dst):
    """工作流另存为 / 改名时，把模板归属一起搬到新路径，避免"模板突然消失"。"""
    if not _valid_workflow_key(src) or not _valid_workflow_key(dst):
        return False, "工作流标识非法"
    if src == dst:
        return True, "无需迁移"
    by_workflow = _presets_load_all()
    bucket = by_workflow.pop(src, None)
    if not bucket:
        return True, "无模板需迁移"
    merged = by_workflow.get(dst) or {}
    merged.update(bucket)
    by_workflow[dst] = merged
    if not _presets_save_all(by_workflow):
        return False, "写入模板文件失败"
    _LOG.info("参数模板已随工作流迁移: %s -> %s（%d 个）", src, dst, len(bucket))
    return True, "模板已迁移到新工作流"


def _preset_delete(workflow, name):
    if not _valid_workflow_key(workflow):
        return False, "工作流标识非法"
    if not _valid_preset_name(name):
        return False, "模板名非法"
    name = name.strip()
    by_workflow = _presets_load_all()
    bucket = by_workflow.get(workflow) or {}
    if name not in bucket:
        return False, "模板不存在: %s" % name
    bucket.pop(name, None)
    if bucket:
        by_workflow[workflow] = bucket
    else:
        by_workflow.pop(workflow, None)
    if not _presets_save_all(by_workflow):
        return False, "写入模板文件失败"
    _LOG.info("已删除参数模板: [%s] %s", workflow, name)
    return True, "模板已删除"


def state_payload():
    keys = _available()
    return {
        "current": _current,
        "available": {k: BACKENDS[k] for k in keys},
        "all": {k: {**v, "available": k in keys} for k, v in BACKENDS.items()},
        "startup_default": _label("auto"),
    }


# ---------------------------------------------------------------- 后端跑分

def _benchmark(params=None):
    """合成注意力微基准：在固定 q/k/v 形状上测各后端裸 kernel 耗时。

    重要：这不是真实出图速度。它只反映"给定形状下、不带 mask 的裸注意力内核"
    的开销，负载规模 / dtype / mask / 块缓存 / 模型路由都和真实工作流不同。
    默认形状贴近常见扩散 Transformer（1024 token / 24 头 / 128 维），
    比早期 256/8/64 更能体现 INT8 / Sage 在大形状下的优势，但仍仅作参考。
    真实速度以 AccelLog 的 [加速汇总] 采样耗时 / [节点耗时] 为准。

    只直接调用注册表里的函数，不修改当前后端 / 不碰已加载模型；
    跑完自动释放临时张量。出错的后端单独记录 error，不影响其他项。
    """
    params = params if isinstance(params, dict) else {}
    try:
        warmup = max(0, min(20, int(params.get("warmup", 2))))
        iters = max(1, min(30, int(params.get("iters", 5))))
        tokens = max(32, min(8192, int(params.get("tokens", 1024))))
        heads = max(1, min(64, int(params.get("heads", 24))))
        dim = max(16, min(256, int(params.get("dim", 128))))
    except (TypeError, ValueError):
        return {"error": "参数必须是整数"}, 400

    dtype_name = str(params.get("dtype", "fp16")).lower()
    if dtype_name not in ("fp16", "bf16"):
        return {"error": "dtype 只支持 fp16 或 bf16"}, 400

    try:
        import torch
        import comfy.model_management as mm
        device = mm.get_torch_device()
        if getattr(device, "type", None) != "cuda":
            return {"error": "后端跑分需要 CUDA 设备"}, 400
        dtype = torch.float16 if dtype_name == "fp16" else torch.bfloat16
    except Exception as e:
        return {"error": "无法获取 GPU: %s" % e}, 400

    registry = _registry()
    results = []
    tensors = None
    try:
        shape = (1, tokens, heads * dim)
        tensors = (torch.randn(shape, device=device, dtype=dtype),
                   torch.randn(shape, device=device, dtype=dtype),
                   torch.randn(shape, device=device, dtype=dtype))
        q, k, v = tensors
        for key in _available():
            if key == "auto":
                continue
            fn = registry.get(key)
            label = _label(key)
            if fn is None:
                results.append({"key": key, "label": label, "error": "后端函数不可用"})
                continue
            try:
                for _ in range(warmup):
                    fn(q, k, v, heads)
                torch.cuda.synchronize(device)
                started = time.perf_counter()
                for _ in range(iters):
                    fn(q, k, v, heads)
                torch.cuda.synchronize(device)
                ms = (time.perf_counter() - started) * 1000.0 / iters
                results.append({"key": key, "label": label, "ms": round(ms, 3)})
            except Exception as e:
                results.append({"key": key, "label": label, "error": str(e)[:240]})
    except Exception as e:
        return {"error": "跑分初始化失败: %s" % e}, 500
    finally:
        del tensors
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass

    results.sort(key=lambda r: r.get("ms", float("inf")))
    shape_desc = "%d token / %d 头 / %d 维 / %s" % (tokens, heads, dim, dtype_name)
    payload = {
        "ok": True,
        "params": {"warmup": warmup, "iters": iters, "tokens": tokens,
                   "heads": heads, "dim": dim, "dtype": dtype_name},
        "shape_desc": shape_desc,
        "results": results,
    }
    # 写进 ComfyUI 日志：用户点跑分后在启动器/控制台就能直接看到，不必开浏览器 F12
    ok_rows = [r for r in results if isinstance(r.get("ms"), (int, float))]
    err_rows = [r for r in results if r.get("error")]
    if ok_rows:
        ranking = " | ".join("%s %.3fms" % (r["label"], r["ms"]) for r in ok_rows)
        _LOG.info("[后端跑分] 合成微基准（%s，预热%d次/计时%d次，毫秒/次，数字越小=此形状下裸内核越快）: %s",
                  shape_desc, warmup, iters, ranking)
    else:
        _LOG.warning("[后端跑分] 没有可用的加速后端完成测试")
    for r in err_rows:
        _LOG.info("[后端跑分] %s 不可用: %s", r["label"], r["error"])
    # 明确边界，避免把微基准排名误当成真实出图速度
    _LOG.info("[后端跑分] 注意：这是固定形状、无 mask 的裸注意力微基准，不是真实出图速度；"
              "真实速度请看 AccelLog 的 [加速汇总] 采样耗时 / [节点耗时]")
    _LOG.info("[后端跑分] 注意：工作流节点自带的路由（如 Qwen T8 的 sage/kitchen 混合）会绕过顶栏切换，"
              "此时切换后端不改变采样速度；可改 POST body 的 tokens/heads/dim/dtype 测其他形状")
    return payload, 200


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

    @routes.post("/accel_switch_benchmark")
    async def benchmark_state(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        payload, status = _benchmark(data)
        return web.json_response(payload, status=status)

    @routes.get("/accel_switch_snapshots")
    async def get_snapshots(request):
        return web.json_response({"ok": True, "snapshots": _snapshots_load()})

    @routes.post("/accel_switch_snapshots")
    async def put_snapshot(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)
        ok, msg = _snapshot_put(data.get("file"), data.get("snapshot"))
        if not ok:
            return web.json_response({"ok": False, "error": msg}, status=400)
        return web.json_response({"ok": True, "message": msg})

    @routes.get("/accel_switch_presets")
    async def get_presets(request):
        workflow = request.query.get("workflow")
        if workflow is not None:
            return web.json_response({"ok": True, "workflow": workflow,
                                      "presets": _presets_for(workflow)})
        return web.json_response({"ok": True, "presets": _presets_load_all()})

    @routes.post("/accel_switch_presets")
    async def post_preset(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)
        workflow = data.get("workflow")
        action = data.get("action", "save")
        if action == "delete":
            ok, msg = _preset_delete(workflow, data.get("name"))
        elif action == "save":
            ok, msg = _preset_put(workflow, data.get("name"), data.get("preset"))
        elif action == "move":
            ok, msg = _preset_move(data.get("from"), data.get("to"))
        else:
            return web.json_response({"ok": False, "error": "未知 action"}, status=400)
        if not ok:
            return web.json_response({"ok": False, "error": msg}, status=400)
        return web.json_response({"ok": True, "message": msg,
                                  "workflow": workflow,
                                  "presets": _presets_for(workflow)})

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
