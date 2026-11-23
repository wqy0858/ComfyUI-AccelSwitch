/**
 * ComfyUI-AccelSwitch — 顶栏一键切换全局注意力加速后端 + 顶栏缩放 + 工作流设置快照
 *
 * 位置：顶部命令栏（与“管理器 / 翻译开关”同一行），优先贴在运行按钮组左侧。
 * 形态：与“运行 ▾”同款 SplitButton——点主体循环切换，点箭头弹出完整列表。
 * 顶栏缩放：下拉菜单 100%~60% 五档，对整个顶栏整列做 CSS zoom，记 localStorage。
 * 快照：保存工作流时记录 [后端 + 缩放 + 所有节点参数(含图像)] 到**服务端**
 *       user/AccelSwitch/snapshots.json；跨浏览器 / 清缓存不丢。
 *       打开工作流自动套用保存时的后端/缩放；菜单「↺」一键恢复全部节点参数。
 *       Ctrl+Alt+A 切换后端，Ctrl+Alt+R 恢复快照。
 * 跑分：合成注意力负载测各可用后端，结果同时写入 ComfyUI 日志 + 界面弹窗。
 * 数据接口见 custom_nodes/ComfyUI-AccelSwitch/__init__.py。
 */

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const API = "./accel_switch";
const SNAP_API = "./accel_switch_snapshots";
const LOG_TAG = "[AccelSwitch]";
const log = (...a) => console.log(LOG_TAG, ...a);
const warn = (...a) => console.warn(LOG_TAG, ...a);

/** @type {{current:string, available:Object, all:Object}} */
let state = { current: "auto", available: {}, all: {} };
let split = null;
let primaryBtn = null;
let badgeText = "";
let inserted = false;
let watchdog = null;
let lastSnapshot = null;   // 最近一次保存的快照（与服务端同步）
let snapshots = {};        // file -> 快照
let fetchHooked = false;
let snapshotsLoaded = false;

// ---------------------------------------------------------------- 顶栏缩放

const ZOOM_KEY = "Comfy.AccelSwitch.TopbarZoom";
const ZOOM_LEVELS = [1, 0.9, 0.8, 0.7, 0.6];
let zoomValue = 0.8;

function loadZoom() {
  try {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (ZOOM_LEVELS.includes(v)) zoomValue = v;
  } catch {
    /* localStorage 不可用保持默认 */
  }
}

function saveZoom() {
  try {
    localStorage.setItem(ZOOM_KEY, String(zoomValue));
  } catch {
    /* 忽略 */
  }
}

function zoomRoot() {
  const ab = document.querySelector('[data-testid="top-menu-actionbars"]');
  if (!ab) return null;
  const col = ab.parentElement;
  if (col && col.contains(ab)) return col;
  return ab;
}

function applyZoom() {
  const el = zoomRoot();
  if (!el) return false;
  el.style.zoom = String(zoomValue);
  return true;
}

function setZoom(z) {
  zoomValue = z;
  saveZoom();
  applyZoom();
  log("顶栏缩放:", Math.round(z * 100) + "%");
  render();
}

// ---------------------------------------------------------------- API

async function apiGet() {
  const r = await fetch(API, { method: "GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function apiSet(key) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: key }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}

async function apiBenchmark(params) {
  const r = await fetch(API + "_benchmark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}

async function apiGetSnapshots() {
  const r = await fetch(SNAP_API, { method: "GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return j.snapshots || {};
}

async function apiPutSnapshot(file, snapshot) {
  const r = await fetch(SNAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, snapshot }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}

// ---------------------------------------------------------------- 工作流设置快照

const SNAP_KEY = "Comfy.AccelSwitch.LastWorkflowSnapshot";
const SNAP_MAP_KEY = "Comfy.AccelSwitch.WorkflowSnapshots";

function cacheSnapshotLocal(snap) {
  lastSnapshot = snap;
  snapshots[snap.file] = snap;
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
    localStorage.setItem(SNAP_MAP_KEY, JSON.stringify(snapshots));
  } catch (e) {
    warn("本地缓存快照失败（不影响服务端存储）:", e.message || e);
  }
}

/** 从 localStorage 读缓存（服务端不可用时的兜底 + 迁移 v1.1.0 单快照）。 */
function loadSnapshotCache() {
  try {
    snapshots = JSON.parse(localStorage.getItem(SNAP_MAP_KEY) || "{}") || {};
  } catch {
    snapshots = {};
  }
  try {
    lastSnapshot = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
  } catch {
    lastSnapshot = null;
  }
  if (lastSnapshot?.file && !snapshots[lastSnapshot.file]) {
    snapshots[lastSnapshot.file] = lastSnapshot;
    try {
      localStorage.setItem(SNAP_MAP_KEY, JSON.stringify(snapshots));
    } catch {
      /* 忽略 */
    }
  }
}

/** 从服务端加载快照（权威来源，跨浏览器共享）。 */
async function loadSnapshotsFromServer() {
  try {
    const fromServer = await apiGetSnapshots();
    snapshots = fromServer;
    // 最近保存的那个作为 lastSnapshot：服务端快照里 savedAt 最大的
    const files = Object.keys(snapshots);
    if (files.length) {
      lastSnapshot = files
        .map((f) => snapshots[f])
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];
    }
    snapshotsLoaded = true;
    log("已从服务端加载工作流快照:", files.length, "个");
    return true;
  } catch (e) {
    warn("从服务端加载快照失败，回退本地缓存:", e.message || e);
    snapshotsLoaded = false;
    return false;
  }
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 取当前画布所有节点的序列化数据（含图像 widget 的真实值）。 */
function graphNodesSerialized() {
  try {
    const g = app.graph;
    if (!g) return [];
    if (typeof g.serialize === "function") {
      return g.serialize().nodes || [];
    }
    if (Array.isArray(g.nodes)) {
      return g.nodes.map((n) => (typeof n.serialize === "function" ? n.serialize() : n));
    }
  } catch (e) {
    warn("读取画布节点失败:", e.message || e);
  }
  return [];
}

/**
 * 给一个序列化节点算「身份键」：类型 + 同类型内的稳定序号（按画布坐标排序）。
 * 数字 id 只在工作流内唯一，换工作流/编辑后会重用，绝不能作为跨快照的匹配键。
 * 这里用 type + 坐标作为身份；recover 时按同样规则重建，保证一一对应。
 */
function nodeIdentity(nodes) {
  // 按 type 分组，组内按坐标排序（左上→右下），分配序号
  const counters = {};
  const index = new Map();
  const sorted = nodes.slice().sort((a, b) => {
    const t = String(a.type || '').localeCompare(String(b.type || ''));
    if (t) return t;
    const pa = a.pos || [0, 0], pb = b.pos || [0, 0];
    return (pa[1] - pb[1]) || (pa[0] - pb[0]);
  });
  for (const n of sorted) {
    const t = String(n.type || '?');
    const seq = counters[t] || 0;
    counters[t] = seq + 1;
    index.set(n.id, t + '#' + seq);
  }
  return index;
}

/** widget 名列表：优先用运行时 node.widgets 的 name，退化到序列化的 name 字段。 */
function widgetNamesOf(node) {
  if (Array.isArray(node?.widgets)) {
    return node.widgets.map((w) => w?.name ?? null);
  }
  return null;
}

/** 保存工作流那一刻，抓后端 / 缩放 / 所有节点参数，写服务端 + 本地缓存。 */
function captureSnapshot(file) {
  const raw = graphNodesSerialized();
  const identities = nodeIdentity(raw);
  // 带上坐标与 widget 名，供恢复时按「类型+序号+名称」安全匹配
  const graphById = {};
  try {
    for (const n of (app.graph?.nodes || [])) graphById[n.id] = n;
  } catch { /* 忽略 */ }
  const nodes = raw.map((n) => {
    const live = graphById[n.id];
    // 运行时的真实 widget 值：某些自定义节点（如 Goohai 加载图像）在序列化时
    // 会把 widget 值换成占位符（0 字节图），真实值只在运行时 widget.value 上。
    // 因此额外抓一份运行时值，恢复时优先用它。
    const runtimeValues = {};
    for (const w of (Array.isArray(live?.widgets) ? live.widgets : [])) {
      if (w && w.name && w.serialize !== false && w.value !== undefined) {
        try { runtimeValues[w.name] = clone(w.value); } catch { /* 忽略不可克隆值 */ }
      }
    }
    // 当前节点上「真正在显示」的预览图 URL —— 这是恢复图像的关键。
    // 新版前端的图存在全局 nodeOutputStore 里，widget 值只是个文件名（Goohai
    // 还会序列化成 0 字节占位图），所以必须抓 store / DOM 里实际显示的图。
    // 来源优先级：store 的 previews > node.imgs > Goohai crop > DOM 覆盖层。
    const previewUrls = [];
    const isPlaceholderUrl = (u) => typeof u === "string" && /placeholder|vrgdg_placeholder/i.test(u);
    const pushUrl = (u) => {
      if (u && typeof u === "string" && !isPlaceholderUrl(u) && !previewUrls.includes(u)) previewUrls.push(u);
    };
    // 1) 全局 nodeOutputStore（新版前端真正的图源）
    try {
      const store = getNodeOutputStore();
      if (store) {
        if (typeof store.getNodePreviews === "function") {
          for (const u of (store.getNodePreviews(live) || [])) pushUrl(u);
        }
        if (typeof store.getNodeImageUrls === "function") {
          for (const u of (store.getNodeImageUrls(live) || [])) pushUrl(u);
        }
      }
    } catch { /* 忽略 */ }
    // 2) node.imgs（标准 ComfyUI 输出预览）
    try {
      for (const img of (live?.imgs || [])) pushUrl(img?.src);
    } catch { /* 忽略 */ }
    // 3) Goohai _guhaiCrop 的 source/displayed（内存里的真实图）
    try {
      const crop = live?._guhaiCrop;
      for (const key of ["displayed", "source"]) {
        const img = crop?.[key];
        if (img?.src) pushUrl(img.src);
      }
    } catch { /* 忽略 */ }
    // 4) DOM 覆盖层
    try {
      const host = document.querySelector(`[data-node-id="${CSS.escape(String(n.id))}"]`);
      if (host) {
        for (const img of host.querySelectorAll("img[data-guhai-crop-preview], img[data-testid='main-image']")) {
          pushUrl(img?.src);
        }
      }
    } catch { /* 忽略 */ }
    return {
      id: n.id,
      identity: identities.get(n.id) || String(n.type),
      type: n.type,
      title: n.title ?? null,
      pos: clone(n.pos) ?? null,
      mode: n.mode ?? 0,
      widgets_values: clone(n.widgets_values) ?? null,
      widgets_values_named: clone(n.widgets_values_named) ?? null,
      runtime_values_named: Object.keys(runtimeValues).length ? runtimeValues : null,
      preview_urls: previewUrls.length ? previewUrls : null,
      widget_names: widgetNamesOf(live) || clone(n.widgets?.map((w) => w.name)) || null,
      flags: clone(n.flags) ?? null,
      properties: clone(n.properties) ?? null,
    };
  });
  const snap = {
    file,
    savedAt: Date.now(),
    backend: state.current,
    zoom: zoomValue,
    nodes,
  };
  cacheSnapshotLocal(snap);
  // 服务端持久化（跨浏览器 / 清缓存不丢）
  apiPutSnapshot(file, snap)
    .then(() => log("快照已写入服务端:", file, "| 节点:", nodes.length))
    .catch((e) => warn("快照写入服务端失败（仅存本地）:", e.message || e));
  log("已记录工作流保存时的设置:", file,
      "| 后端:", state.current,
      "| 缩放:", Math.round(zoomValue * 100) + "%",
      "| 节点:", nodes.length);
}

/** 从 body 里尽力解析出文件标识（新版 storeUserData 的 body 可能含 full_info 等）。 */
function parseWorkflowFile(routeStr) {
  try {
    const clean = String(routeStr || "").split("?")[0];
    if (!clean.startsWith("/userdata/")) return null;
    const file = decodeURIComponent(clean.slice("/userdata/".length));
    if (!file.startsWith("workflows/") || !file.endsWith(".json") || file.endsWith(".index.json")) {
      return null;
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * 拦截 api.fetchApi：
 *  - POST /userdata/workflows/xxx.json 成功 → 抓快照
 *  - GET  同上成功 → 自动套用保存时的后端/缩放
 * 新版前端 1.59 保存走 api.storeUserData -> api.fetchApi，钩子仍然生效。
 */
function hookWorkflowSave() {
  if (fetchHooked || !api || typeof api.fetchApi !== "function") return;
  const original = api.fetchApi.bind(api);
  api.fetchApi = async function (route, init) {
    const method = ((init?.method) || "GET").toUpperCase();
    const file = parseWorkflowFile(route);
    const response = await original(route, init);
    try {
      if (!file || !response || response.ok === false) return response;
      if (method === "POST") {
        // 直接读画布当前状态，比解析 body 更可靠（body 格式随前端版本变化）
        captureSnapshot(file);
      } else if (method === "GET") {
        const snap = snapshots[file];
        if (snap) {
          log("打开工作流，自动套用保存时的插件设置:", file);
          await applySnapshotSettings(snap, false);
        }
      }
    } catch (e) {
      warn("工作流快照处理失败:", e.message || e);
    }
    return response;
  };
  fetchHooked = true;
}

/** 是否图片/媒体加载类节点（这类节点改值后要触发预览刷新）。 */
function isMediaLoader(type) {
  const t = String(type || '').toLowerCase();
  return ['loadimage', 'loadimagegoohai', 'loadimagemask', 'loadimageoutput',
          'loadvideo', 'loadaudio', 'loadgif', 'imageloader'].includes(t)
    || (t.includes('load') && (t.includes('image') || t.includes('video') || t.includes('audio')));
}

/**
 * 触发 widget 值变更后的副作用（图片预览等靠这个刷新）。
 * 注意：不要在这里调用 node.onConfigure({})——对 Goohai 加载图像这类节点，
 * onConfigure 会用传入的 config 重置 widget 值，把刚写回的图像值又覆盖掉。
 */
function notifyWidgetChange(node, widget, value) {
  try {
    widget.value = value;
  } catch { /* 忽略只读 widget */ }
  // ComfyUI 自定义节点的 callback 签名因版本而异：老版 callback(v)，
  // 新版 image/combo 的 callback(v, canvas, node, pos, event)。参数不足时
  // 某些实现读不到值，所以尽量补全后两个参数。
  try {
    if (typeof widget.callback === "function") {
      try { widget.callback(value, app.canvas, node); }
      catch { widget.callback(value); }
    }
  } catch { /* 忽略 */ }
  try { node.onPropertyChanged?.(widget.name, value); } catch { /* 忽略 */ }
}

/**
 * 清除媒体节点上「恢复前残留」的旧预览。
 *
 * 用户反馈的核心症状：恢复后值其实是对的，但旧图仍挂在节点上，视觉上像没恢复。
 * 旧图会残留在三处，必须一起清掉：
 *   1) node.imgs —— canvas 上绘制的图（Goohai 的 update 在 displayed 为 null
 *      时不会主动清它，旧图就一直留着，见其源码第 156-160 行）
 *   2) DOM 覆盖层 img[data-guhai-crop-preview] —— Goohai 覆盖在 main-image
 *      之上的预览层
 *   3) main-image 的 opacity=0 —— 被覆盖层压暗的原图，不清掉会一直透明
 */
function clearStaleMediaPreview(node) {
  // 1) canvas 绘制的图。Goohai 的空图官方态是 imgs=null（见其
  //    keepEmptyLoadImageNodeInteractive），用 null 而非 [] 才彻底。
  try { node.imgs = null; node.imageIndex = null; } catch { /* 忽略 */ }
  // 2) + 3) Goohai DOM 覆盖层与被压暗的原图
  try {
    const host = document.querySelector(`[data-node-id="${CSS.escape(String(node.id))}"]`);
    if (host) {
      for (const img of host.querySelectorAll('img[data-guhai-crop-preview]')) {
        try {
          const parent = img.parentElement;
          if (parent) parent._guhaiCropPreviewSrc = null; // 清掉缓存，防 update 又贴回来
          img.remove();
        } catch { /* 忽略 */ }
      }
      for (const main of host.querySelectorAll('img[data-testid="main-image"]')) {
        try {
          if (main.parentElement) main.parentElement._guhaiCropPreviewSrc = null;
          main.style.opacity = "";
        } catch { /* 忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
  try { node.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
}

/**
 * 强制把 Goohai 加载图像节点清成"空图"状态。
 *
 * 背景：Goohai 内部闭包变量 displayed/source 存着当前显示的图（如 00003.png），
 * 只要它不清，每次 _guhaiCrop.update() 都会把旧图贴回 node.imgs（源码第 156 行）。
 * 而占位图 vrgdg_placeholder_i2i.png 不算"空"（isEmptyImageValue 只认 ""/"无"），
 * 直接 update 会去加载这个 0 字节图、失败后仍保留旧 displayed。
 *
 * 做法：临时把 image widget 值设成 ""，调 update() 让它走官方清空分支
 * （source=null/displayed=null/editor.setSource(null)），再把值设回原来的占位图。
 * 设回值时故意不调 update——否则又会拿占位图去加载。
 */
function forceGoohaiEmpty(node) {
  if (!isMediaLoader(node.type) || node._guhaiMaskEditorActive) return;
  const w = (node.widgets || []).find((x) => x?.name === "image");
  const crop = node._guhaiCrop;
  const original = w?.value;
  try {
    // 1) 临时置空 + 走官方清空分支
    if (w) w.value = "";
    if (crop && typeof crop.update === "function") crop.update(true);
    // 2) 立即清掉 canvas / DOM 残留
    clearStaleMediaPreview(node);
  } catch { /* 忽略 */ }
  finally {
    // 3) 把值设回快照恢复的占位图（恢复"保存时的参数"），但不触发 update
    if (w && original !== undefined) {
      try { w.value = original; } catch { /* 忽略 */ }
    }
  }
}

/**
 * 拿到新版前端（1.59+）的全局 nodeOutputStore。
 *
 * 关键背景：新版前端用 Pinia store `nodeOutput` 统一管理「每个节点显示哪张图」。
 * 图像加载节点的 callback 内部就是调 store.setNodeOutputs(node, 文件名) 来登记图的；
 * showPreview 再从该 store 取 URL 加载。所以程序改了 widget.value 之后，必须同步
 * 更新这个 store，否则 store 里仍是旧图，一重绘旧图就回来 —— 这正是「恢复了但旧图
 * 还挂着、F5 刷新才对」的根因（F5 重建了整个 store）。
 *
 * Pinia 挂在 Vue app 的 globalProperties.$pinia 上，store 实例在其内部 Map `_s`，
 * key 为 'nodeOutput'。全链路都有降级保护，老前端拿不到就返回 null。
 */
let _nodeOutputStoreCached = null;
// 诊断：本轮恢复图像预览的命中情况（写进结果面板，便于确认是否生效）
const _diagPreview = { store: false, nodes: 0, loaded: 0, urls: 0, cleared: 0 };
function getNodeOutputStore() {
  if (_nodeOutputStoreCached) return _nodeOutputStoreCached;
  try {
    // Vue 3 挂载后会把 app 实例放到挂载容器的 __vue_app__ 上。
    const containers = [document.querySelector("#vue-app"), document.getElementById("vue-app")];
    let pinia = null;
    for (const el of containers) {
      const vueApp = el?.__vue_app__;
      const p = vueApp?.config?.globalProperties?.$pinia;
      if (p) { pinia = p; break; }
    }
    const store = pinia?._s?.get("nodeOutput");
    if (store && typeof store.setNodeOutputs === "function") {
      _nodeOutputStoreCached = store;
      log("拿到前端 nodeOutputStore，图像预览将走 store 刷新");
    }
  } catch { /* 忽略 */ }
  return _nodeOutputStoreCached || null;
}

/** 取出节点 image widget 当前的值（恢复后已是快照值）。 */
function imageWidgetValue(node) {
  const w = (node.widgets || []).find((x) => x?.name === "image");
  if (!w || w.value == null) return null;
  if (Array.isArray(w.value)) return w.value[0] || null;
  return String(w.value);
}

/**
 * 图像值是不是「序列化占位符」（0 字节空图，画不出东西）。
 * 典型：Goohai 加载图像在保存工作流时把真实图名换成 vrgdg_placeholder_i2i.png，
 * 真实图名只在运行时 widget.value 上。用占位符覆盖当前真实图 = 把好好的图改坏。
 */
function isPlaceholderImage(v) {
  return typeof v === "string" && /placeholder|占位/i.test(v);
}

/**
 * 恢复所有加载图像类节点的预览（通用机制，不依赖具体插件）。
 *
 * 前端 showPreview() 的完整链路（读 1.59.11 源码确认）：
 *   1) nodeOutputStore.setNodeOutputs(node, 文件名)   ← 登记图到 store
 *   2) nodeOutputStore.getNodeImageUrls(node)        ← 从 store 取出 /view URL
 *   3) 加载 URL 成 HTMLImageElement
 *   4) node.imgs = [img] + setDirtyCanvas            ← 真正画到节点上
 * 缺任何一步图都不会变。setNodeOutputs 本身只改数据、不重画，之前漏了 2/3/4。
 */
function refreshMediaPreview(node, item) {
  if (!isMediaLoader(node.type)) return;
  if (node._guhaiMaskEditorActive) return;

  _diagPreview.nodes++;
  const value = imageWidgetValue(node);
  const store = getNodeOutputStore();
  if (store) _diagPreview.store = true;

  // 解析 image 值的目录类型：snapshot 值是 "文件名" 或 "子目录/文件名 [output]" 等
  const { filename, folder } = parseImageWidgetValue(value);

  // ★ 优先用快照保存时「真正在显示」的图 URL。widget 值常是 0 字节占位图
  //   （Goohai 尤其如此），拿它拼 URL 必然加载失败 —— 这才是「重绘 0 个」的原因。
  const snapUrls = Array.isArray(item?.preview_urls)
    ? item.preview_urls.filter((u) => typeof u === "string" && !/placeholder/i.test(u))
    : [];
  let urls = snapUrls.length ? snapUrls.slice(0, 1) : null;

  // 没有快照图 URL 时，才退回 widget 值：登记进 store 并从 store 取 URL。
  if (!urls) {
    if (store && filename && !/placeholder/i.test(filename)) {
      try {
        store.setNodeOutputs(node, filename, { folder });
        urls = typeof store.getNodeImageUrls === "function"
          ? store.getNodeImageUrls(node) : null;
      } catch (e) {
        warn("setNodeOutputs 失败，改用直构 URL:", e.message || e);
      }
    }
    if ((!urls || !urls.length) && filename && !/placeholder/i.test(filename)) {
      urls = [buildViewUrl(filename, folder)];
    }
  }
  if (urls?.length) _diagPreview.urls += urls.length;
  log("刷新图像预览:", node.type, "| 值:", String(value).slice(0, 50),
      "| 用快照URL:", !!snapUrls.length, "| URL:", String(urls?.[0]).slice(0, 80));

  // ★ 保存时就是「空图」状态（widget 值是 0 字节占位图 / 无图，且快照没有
  //   真实预览图）——恢复就该把当前画布上的图清掉，回到空图。
  //   之前错误地"跳过保留"，导致当前那张图一直挂着、看着像没恢复。
  if ((!urls || !urls.length) && (!filename || /placeholder/i.test(filename))) {
    _diagPreview.cleared++;
    clearStaleMediaPreview(node); // imgs=null + 移除 DOM 覆盖层 + 清缓存
    // ★ 关键：Goohai 内部有个 displayed 变量存着旧图（如 00003.png），
    //   只要它不清，每次 update() 都会在第 156 行把旧图贴回 node.imgs。
    //   占位图不算"空"（isEmptyImageValue 只认 ""/"无"），所以直接 update
    //   反而会加载占位图失败、保留旧 displayed。
    //   正确做法：临时把 widget 值设成 "" → 调 update() 走官方清空分支
    //   （source=null/displayed=null/setSource(null)）→ 再把值设回占位图。
    forceGoohaiEmpty(node);
    // configure 的异步链 + Goohai 自己的延迟回调跑完后，多次兜底
    setTimeout(() => forceGoohaiEmpty(node), 250);
    setTimeout(() => forceGoohaiEmpty(node), 900);
    setTimeout(() => clearStaleMediaPreview(node), 1600);
    log("恢复为空图状态（已清掉当前残留画面）:", node.type);
    return;
  }

  // 3) + 4) 清旧图 → 加载新 URL → 贴回 node.imgs（带防缓存 rand）
  clearStaleMediaPreview(node);
  const finalUrls = urls;
  const paint = () => {
    if (!Array.isArray(finalUrls) || !finalUrls.length || !isMediaLoader(node.type)) return;
    loadPreviewImages(finalUrls.slice(0, 1)).then((imgs) => {
      if (!imgs.length) return;
      node.imgs = imgs;
      node.imageIndex = null;
      node.setDirtyCanvas?.(true, true);
      try { node.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
      // vue 节点模式下还要同步一次 legacy imgs（前端 syncLegacyNodeImgs 的等价）
      try {
        if (store && typeof store.syncLegacyNodeImgs === "function" && globalThis.LiteGraph?.vueNodesMode) {
          store.syncLegacyNodeImgs(node.id, imgs[0], 0);
        }
      } catch { /* 忽略 */ }
      _diagPreview.loaded++;
    });
  };
  // configure 的 onConfigure 是异步的，延迟让它先跑完再贴新图，避免被覆盖
  paint();
  setTimeout(paint, 250);
  setTimeout(paint, 900);
}

/** 解析 image widget 值 → {filename, folder}。folder 取 input/output/temp。 */
function parseImageWidgetValue(value) {
  let s = String(value ?? "").trim();
  let folder = "input";
  const m = s.match(/\[(input|output|temp)\]\s*$/i);
  if (m) { folder = m[1].toLowerCase(); s = s.slice(0, m.index).trim(); }
  s = s.replaceAll("\\", "/");
  const filename = s.split("/").pop() || "";
  // 子目录：ComfyUI 的 /view 需要 subfolder，这里把路径部分也带上
  return { filename, folder, fullPath: s };
}

/** 直接构造 ComfyUI /view URL（store 未命中时的兜底），带 rand 防缓存。 */
function buildViewUrl(fullPath, folder) {
  try {
    const parts = String(fullPath).replaceAll("\\", "/").split("/");
    const filename = parts.pop() || "";
    const subfolder = parts.join("/");
    const qs = new URLSearchParams({ filename, type: folder, rand: String(Date.now()) });
    if (subfolder) qs.set("subfolder", subfolder);
    return (typeof api !== "undefined" && api.apiURL)
      ? api.apiURL(`/view?${qs.toString()}`)
      : `/view?${qs.toString()}`;
  } catch { return ""; }
}

/** 把 URL 列表加载成 HTMLImageElement（用于恢复预览）。 */
async function loadPreviewImages(urls) {
  const out = [];
  for (const url of urls) {
    try {
      const img = new Image();
      img.src = url;
      if (img.decode) {
        await img.decode();
      } else {
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      }
      out.push(img);
    } catch { /* 单张失败跳过 */ }
  }
  return out;
}

/**
 * 套用快照设置。
 * withNodes=true 时恢复节点参数——但严格按「类型 + 同类型序号」匹配，
 * 绝不按数字 id（id 跨工作流会撞车，导致把 A 节点的值套给 B 节点）。
 * 打开工作流时只套后端/缩放（节点参数本来就来自工作流文件本身）。
 */
async function applySnapshotSettings(snap, withNodes = true) {
  if (!snap) return 0;
  let matched = 0;
  const skipped = [];
  _diagPreview.store = false; _diagPreview.nodes = 0; _diagPreview.loaded = 0; _diagPreview.urls = 0; _diagPreview.cleared = 0;
  if (withNodes) {
    try {
      const graph = app.graph;
      const liveNodes = Array.isArray(graph?.nodes) ? graph.nodes.slice() : [];
      // 用相同规则给「当前画布」的节点算身份键
      const liveIdentities = nodeIdentity(liveNodes);
      const byIdentity = new Map();
      for (const n of liveNodes) {
        const key = liveIdentities.get(n.id);
        if (key && !byIdentity.has(key)) byIdentity.set(key, n);
      }

      for (const item of snap.nodes || []) {
        // 1) 只按类型身份匹配；快照没 identity 就用 type 退化匹配
        const key = item.identity || String(item.type || '');
        let node = byIdentity.get(key);
        if (!node) {
          // 退化：旧快照无 identity 时，找同 type 的第一个未被占用节点
          node = liveNodes.find((n) => String(n.type) === String(item.type)
            && !skipped.includes('used:' + n.id));
        }
        if (!node) {
          skipped.push(String(item.type || '?') + '(当前画布无此类型)');
          continue;
        }
        // 2) 铁律：类型必须一致，否则绝不套值（防张冠李戴）
        if (String(node.type) !== String(item.type)) {
          skipped.push('#' + item.id + '(类型不符:' + item.type + '≠' + node.type + ')');
          continue;
        }
        if (skipped.includes('used:' + node.id)) {
          skipped.push(String(item.type) + '(重复实例)');
          continue;
        }
        skipped.push('used:' + node.id);

        try {
          // 用 LiteGraph 官方 node.configure() 恢复全部参数——这是 1.59 前端
          // 唯一能正确驱动 widget 恢复 + 节点 onConfigure 钩子的路径。
          // 关键：properties 必须随 configure 一起传入（Goohai 加载图像的真实
          // 图源、透明通道、遮罩状态都在 properties 里），且必须在 configure
          // 之前备好——否则节点 onConfigure 读到的是旧 properties，图就变了。
          const base = (typeof node.serialize === "function") ? node.serialize() : {};

          // ★ 图像加载节点保护：Goohai 这类节点保存工作流时会把真实图名换成
          //   0 字节占位图（vrgdg_placeholder_i2i.png），真实图名只在运行时
          //   widget.value / preview_urls 上。如果这份快照里图像值全是占位符、
          //   又没有抓到真实预览 URL，那么把快照值写回去只会把当前正确的图
          //   （如 00003.png）改成空白占位图 —— 这正是"恢复后乱改"的根因。
          //   此时保留当前画布的图像 widget 值与图像类 properties，不动它。
          const info = {
            ...base,
            id: node.id, // 用当前节点 id，不用快照 id（快照 id 会撞车）
            widgets_values: clone(item.widgets_values) ?? base.widgets_values,
            mode: item.mode ?? base.mode ?? 0,
            title: item.title ?? base.title,
            flags: clone(item.flags) ?? base.flags,
            properties: clone(item.properties) ?? base.properties,
          };
          if (item.widgets_values_named) {
            info.widgets_values_named = clone(item.widgets_values_named);
          }
          if (typeof node.configure === "function") {
            node.configure(info);
          } else {
            // 极老前端兜底：按名逐个写
            const widgets = Array.isArray(node.widgets) ? node.widgets : [];
            const snapNames = Array.isArray(item.widget_names) ? item.widget_names : null;
            for (let i = 0; i < widgets.length; i++) {
              const w = widgets[i];
              if (!w || w.serialize === false) continue;
              let val;
              if (snapNames && item.widgets_values_named
                  && Object.prototype.hasOwnProperty.call(item.widgets_values_named, w.name)) {
                val = item.widgets_values_named[w.name];
              } else if (snapNames) {
                const snapIdx = snapNames.indexOf(w.name);
                val = snapIdx >= 0 ? item.widgets_values[snapIdx] : undefined;
              } else {
                val = item.widgets_values?.[i];
              }
              if (val === undefined) continue;
              notifyWidgetChange(node, w, val);
            }
            if (item.properties && node.properties) {
              for (const k of Object.keys(item.properties)) {
                if (k === "ue_properties" || k === "widget_ue_connectable") continue;
                try { node.properties[k] = clone(item.properties[k]); } catch { /* 忽略 */ }
              }
            }
          }
          // configure 之后，再统一触发媒体节点预览刷新。此时 widget 值和
          // properties 都已是恢复后的值，Goohai 的 _guhaiCrop 才会加载正确的图。
          refreshMediaPreview(node, item);
          try { node.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
          matched++;
        } catch (e) {
          warn("恢复节点 " + key + " 失败:", e.message || e);
        }
      }
      graph?.setDirtyCanvas?.(true, true);
      const realSkipped = skipped.filter((s) => !s.startsWith('used:'));
      if (realSkipped.length) log("恢复时跳过（安全校验）:", realSkipped.slice(0, 12).join(', '));
    } catch (e) {
      warn("恢复节点设置失败:", e.message || e);
    }
  }

  if (snap.backend && snap.backend !== state.current) {
    try {
      await choose(snap.backend);
    } catch (e) {
      warn("恢复加速后端失败:", e.message || e);
    }
  }
  if (typeof snap.zoom === "number" && ZOOM_LEVELS.includes(snap.zoom)) {
    setZoom(snap.zoom);
  }
  log("已套用保存时的设置:", snap.file, "| 匹配节点:", matched);
  return matched;
}

/** 一键恢复：后端 + 顶栏缩放 + 所有节点参数（含图像）。 */
async function restoreSnapshot() {
  // 优先服务端最新快照
  if (snapshotsLoaded) {
    try {
      await loadSnapshotsFromServer();
    } catch {
      /* 用现有缓存 */
    }
  }
  const snap = lastSnapshot;
  if (!snap) {
    warn("还没有快照：请先保存一次工作流");
    flashNotice("无快照", false);
    return;
  }
  const matched = await applySnapshotSettings(snap, true);
  flashNotice("✓ 已恢复", true);
  log("恢复完成:", snap.file, "| 匹配节点:", matched);
  showResultPanel("设置已恢复", [
    "工作流: " + snap.file,
    "恢复节点: " + matched + " 个（含图像等参数）",
    "后端: " + (state.available[snap.backend]?.label || snap.backend || "-"),
    "保存时间: " + (snap.savedAt ? new Date(snap.savedAt).toLocaleString() : "-"),
    "图像节点 " + _diagPreview.nodes + " 个 / 重绘 " + _diagPreview.loaded + " 个 / 清空为空图 " + _diagPreview.cleared + " 个",
    "图像源: " + (_diagPreview.cleared > 0
      ? "保存时是空图，已清掉当前画面恢复空图状态"
      : (_diagPreview.store ? "新版 store 已接管" : "widget 值恢复")),
  ], true);
}

// ---------------------------------------------------------------- 可见结果面板

let resultPanel = null;
let resultTimer = null;
function showResultPanel(title, lines, ok = true) {
  try {
    if (resultPanel) resultPanel.remove();
    if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
    const el = document.createElement("div");
    el.id = "accel-switch-result";
    Object.assign(el.style, {
      position: "fixed", right: "18px", bottom: "18px", zIndex: "99999",
      maxWidth: "440px", minWidth: "300px", padding: "14px 16px",
      background: "var(--color-background-primary, #1e1e1e)",
      color: "var(--color-text-primary, #ddd)",
      border: "1px solid " + (ok ? "#1D9E75" : "#E24B4A"),
      borderRadius: "10px", font: "13px/1.6 var(--font-sans, sans-serif)",
      boxShadow: "0 6px 24px rgba(0,0,0,.3)",
    });
    const h = document.createElement("div");
    h.textContent = title;
    Object.assign(h.style, { fontWeight: "600", marginBottom: "8px", fontSize: "14px" });
    el.appendChild(h);
    for (const line of lines) {
      const p = document.createElement("div");
      p.textContent = line;
      p.style.whiteSpace = "pre-wrap";
      el.appendChild(p);
    }
    const close = document.createElement("div");
    close.textContent = "点击关闭";
    Object.assign(close.style, { marginTop: "10px", opacity: ".6", cursor: "pointer", fontSize: "12px" });
    close.onclick = () => el.remove();
    el.appendChild(close);
    (document.body || document.documentElement).appendChild(el);
    resultPanel = el;
    resultTimer = setTimeout(() => { if (el.parentNode) el.remove(); resultPanel = null; }, 12000);
  } catch (e) {
    warn("显示结果面板失败:", e.message || e);
  }
}

/** 跑分：后端写日志 + 前端弹面板，点一下就能看到，不用开 F12。 */
async function runBenchmark(params) {
  flashNotice("测速中…", true);
  try {
    const j = await apiBenchmark(params);
    const rows = j.results || [];
    const okRows = rows.filter((r) => typeof r.ms === "number");
    const errRows = rows.filter((r) => r.error);
    const shape = j.shape_desc || (function () {
      const p = j.params || {};
      return p.tokens ? `${p.tokens} token / ${p.heads} 头 / ${p.dim} 维 / ${p.dtype || "fp16"}` : "合成负载";
    })();
    const lines = ["形状: " + shape + "（预热/计时后取平均，毫秒/次）"];
    lines.push("注意：这是固定形状、无 mask 的裸注意力微基准，不是真实出图速度");
    lines.push("真实速度看日志 [加速汇总] 的采样耗时；T8 等节点自带路由会绕过顶栏切换");
    lines.push("---");
    const ranked = okRows.length
      ? okRows.map((r, i) => (i + 1) + ". " + r.label + "  " + r.ms + " ms")
      : ["没有可用的后端完成测试"];
    lines.push(...ranked);
    for (const r of errRows) lines.push("✗ " + r.label + ": " + r.error);
    lines.push("---");
    lines.push("参数: " + JSON.stringify(j.params || {}));
    lines.push("完整结果已写入 ComfyUI 日志（搜索「后端跑分」）");
    console.table(rows);
    log("后端微基准完成:", lines.join(" | "));
    flashNotice("✓ 跑分完成", true);
    showResultPanel("后端微基准（合成负载，越小=此形状内核越快）", lines, okRows.length > 0);
  } catch (e) {
    warn("跑分失败:", e.message || e);
    flashError();
    showResultPanel("跑分失败", [e.message || String(e)], false);
  }
}

// ---------------------------------------------------------------- 组件

async function getComponents() {
  if (window.comfyAPI?.button?.ComfyButton && window.comfyAPI?.splitButton?.ComfySplitButton) {
    const { ComfyButton } = window.comfyAPI.button;
    const { ComfySplitButton } = window.comfyAPI.splitButton;
    return { ComfyButton, ComfySplitButton };
  }
  const [b, s] = await Promise.all([
    import("../../../scripts/ui/components/button.js"),
    import("../../../scripts/ui/components/splitButton.js"),
  ]);
  return { ComfyButton: b.ComfyButton, ComfySplitButton: s.ComfySplitButton };
}

function keys() {
  return Object.keys(state.available);
}

function cycleKey() {
  const ks = keys();
  if (!ks.length) return "auto";
  const i = ks.indexOf(state.current);
  return ks[(i + 1) % ks.length];
}

async function choose(key) {
  try {
    const j = await apiSet(key);
    state.current = j.current || key;
    if (j.available) state.available = j.available;
    if (j.all) state.all = j.all;
    log("切换成功:", j.message || state.current);
    render();
  } catch (e) {
    warn("切换失败:", e.message || e);
    flashError();
  }
}

function flashError() {
  flashNotice("⚠ 失败", false);
}

let noticeTimer = null;
function flashNotice(text, ok) {
  if (!primaryBtn) return;
  if (noticeTimer) clearTimeout(noticeTimer);
  primaryBtn.content = text;
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    if (primaryBtn) primaryBtn.content = badgeText;
  }, 1800);
}

async function render() {
  const { ComfyButton, ComfySplitButton } = await getComponents();
  const cur = state.current;
  const curLabel = state.available[cur]?.label || state.all?.[cur]?.label || cur;
  const curShort = state.available[cur]?.short || state.all?.[cur]?.short || cur;
  badgeText = curShort;
  primaryBtn = new ComfyButton({
    icon: "bolt",
    content: curShort,
    tooltip: `全局注意力加速：${curLabel}（Ctrl+Alt+A 切换，▾ 选列表，Ctrl+Alt+R 恢复快照）`,
    action: () => choose(cycleKey()),
  });
  const allKeys = Object.keys(
    state.all && Object.keys(state.all).length ? state.all : state.available
  );
  const items = allKeys.map((key) => {
    const b = state.all?.[key] || state.available[key] || { label: key };
    const active = key === cur;
    const available = b.available !== false;
    return new ComfyButton({
      content: (active ? "✓  " : "    ") + b.label,
      tooltip: available ? (b.desc || "")
        : `${b.desc || b.label}：当前不可用（未安装或硬件不支持）`,
      classList: "accel-switch-item" + (active ? " accel-switch-active" : "")
        + (available ? "" : " accel-switch-unavailable"),
      action: () => available ? choose(key) : flashNotice("当前不可用", false),
    }).element;
  });
  items.push(new ComfyButton({
    content: "     ⚡ 后端微基准（合成）",
    tooltip: "固定形状裸注意力微基准（默认 1024 token/24 头/128 维），结果弹窗+日志；"
           + "不是真实出图速度，真实速度看 [加速汇总]",
    classList: "accel-switch-item accel-switch-bench-item",
    action: () => runBenchmark(),
  }).element);
  items.push(new ComfyButton({
    content: "     ⚡ 微基准：Qwen 大形状",
    tooltip: "贴近 Qwen Image 2.1：4096 token / 24 头 / 128 维 bf16；显存占用更高",
    classList: "accel-switch-item accel-switch-bench-item",
    action: () => runBenchmark({ tokens: 4096, heads: 24, dim: 128, dtype: "bf16", iters: 3 }),
  }).element);
  items.push(new ComfyButton({
    content: (lastSnapshot ? "↺  " : "    ") + "恢复上次保存的设置",
    tooltip: lastSnapshot
      ? `恢复 ${lastSnapshot.file} 保存时的后端 / 缩放 / ${lastSnapshot.nodes?.length || 0} 个节点参数（含图像）`
      : "尚无快照：请先保存一次工作流",
    classList: "accel-switch-item accel-switch-restore-item" + (lastSnapshot ? " accel-switch-active" : ""),
    action: () => restoreSnapshot(),
  }).element);
  const sep = document.createElement("div");
  sep.className = "accel-switch-sep";
  items.push(sep);
  for (const z of ZOOM_LEVELS) {
    const active = z === zoomValue;
    items.push(new ComfyButton({
      content: (active ? "✓  " : "    ") + `顶栏缩放 ${Math.round(z * 100)}%`,
      tooltip: z === 1 ? "恢复顶栏原始大小"
        : `整个顶栏缩小到 ${Math.round(z * 100)}%（含队列/任务浮层）`,
      classList: "accel-switch-item accel-switch-zoom-item",
      action: () => setZoom(z),
    }).element);
  }
  const old = split?.element;
  split = new ComfySplitButton({ primary: primaryBtn, mode: "click" }, ...items);
  split.element.id = "accel-switch-split";
  if (old && old.parentElement) {
    old.parentElement.replaceChild(split.element, old);
  } else {
    insert();
  }
}

// ---------------------------------------------------------------- 插入命令栏

function isVisibleEl(el) {
  if (!el) return false;
  if (el.offsetParent !== null) return true;
  try {
    return getComputedStyle(el).display !== "none";
  } catch {
    return false;
  }
}

function insert() {
  if (!split) return false;
  const sg = app.menu?.settingsGroup?.element;
  if (sg && typeof sg.before === "function") {
    sg.before(split.element);
    if (split.element.parentElement) {
      inserted = true;
      return true;
    }
  }
  const host = app.ui?.menuContainer || document.querySelector(".comfy-menu");
  const comfyMenu = document.querySelector(".comfy-menu");
  if (host && isVisibleEl(comfyMenu) && isVisibleEl(host)) {
    const runBtn = host.querySelector?.(".comfyui-split-button");
    if (runBtn && runBtn !== split.element && runBtn.parentElement === host) {
      host.insertBefore(split.element, runBtn);
    } else {
      host.appendChild(split.element);
    }
    inserted = true;
    return true;
  }
  const topRight = document.querySelector(".workflow-tabs-container .ml-auto");
  if (topRight) {
    topRight.prepend(split.element);
    inserted = true;
    return true;
  }
  const topBar = document.querySelector(".workflow-tabs-container");
  if (topBar) {
    topBar.appendChild(split.element);
    inserted = true;
    return true;
  }
  return false;
}

function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    const zr = zoomRoot();
    if (zr && zr.style.zoom !== String(zoomValue)) applyZoom();
    if (!split) return;
    if (!split.element.isConnected) {
      insert();
      return;
    }
    const runBtn = document.querySelector(".comfyui-split-button");
    if (runBtn && runBtn !== split.element
        && split.element.parentElement === runBtn.parentElement
        && split.element.nextElementSibling !== runBtn) {
      const pos = split.element.compareDocumentPosition(runBtn);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
        runBtn.parentElement.insertBefore(split.element, runBtn);
      }
    }
  }, 2000);
}

// ---------------------------------------------------------------- 样式注入

const STYLE_ID = "accel-switch-style";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = [
    "#accel-switch-split .comfyui-split-primary .comfyui-button{padding-left:10px;padding-right:10px}",
    ".accel-switch-sep{height:1px;margin:4px 6px;background:currentColor;opacity:.25;flex:none}",
    ".accel-switch-zoom-item{font-size:.92em}",
    ".accel-switch-restore-item{font-weight:600}",
    ".accel-switch-unavailable{opacity:.4;cursor:not-allowed}",
    ".accel-switch-bench-item{font-weight:600}",
  ].join("\n");
  (document.head || document.documentElement).appendChild(st);
}

// ---------------------------------------------------------------- 快捷键

function setupHotkeys() {
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.altKey) || e.shiftKey || e.metaKey) return;
    const target = e.target;
    if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
        || target.isContentEditable)) return;
    if (e.code === "KeyA") {
      e.preventDefault();
      log("快捷键 Ctrl+Alt+A：切换后端");
      choose(cycleKey());
    } else if (e.code === "KeyR") {
      e.preventDefault();
      log("快捷键 Ctrl+Alt+R：恢复快照");
      restoreSnapshot();
    }
  });
}

// ---------------------------------------------------------------- 扩展入口

app.registerExtension({
  name: "ComfyUI.AccelSwitch",

  async setup() {
    loadZoom();
    loadSnapshotCache();
    hookWorkflowSave();
    setupHotkeys();
    injectStyles();
    // Vue app / Pinia store 比扩展 setup 更晚挂载，延迟预热抓取 nodeOutputStore
    setTimeout(() => getNodeOutputStore(), 800);
    setTimeout(() => getNodeOutputStore(), 2500);
    // 服务端快照为权威来源，异步拉；拉到后重绘菜单（让「↺」项显示）
    loadSnapshotsFromServer().then(() => render()).catch(() => {});
    let tries = 0;
    while (tries++ < 60) {
      try {
        const j = await apiGet();
        state.current = j.current || "auto";
        state.available = j.available || {};
        state.all = j.all || {};
        await render();
        applyZoom();
        if (inserted) break;
      } catch (e) {
        if (tries === 1) warn("初始状态获取失败，重试中:", e.message || e);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!inserted) {
      warn("未找到顶栏锚点，加速切换按钮未插入");
      return;
    }
    applyZoom();
    startWatchdog();
    log("顶栏按钮已就绪 | 当前:", state.current, "| 可用:", keys().join(", "),
        "| 顶栏缩放:", Math.round(zoomValue * 100) + "%",
        "| 服务端快照:", snapshotsLoaded ? "已加载" : "本地缓存");
  },
});
