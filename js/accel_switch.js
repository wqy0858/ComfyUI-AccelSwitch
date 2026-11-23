/**
 * ComfyUI-AccelSwitch — 顶栏一键切换全局注意力加速后端 + 顶栏缩放 + 工作流设置快照
 *
 * 位置：顶部命令栏（与“管理器 / 翻译开关”同一行），优先贴在运行按钮组左侧。
 * 形态：与“运行 ▾”同款 SplitButton——点主体=恢复上次保存的样子（参数+连线+位置），
 *       点箭头弹出完整列表（选后端）。
 * 顶栏缩放：下拉菜单里拖动滑块 50%~100% 连续调节，对整个顶栏整列做 CSS zoom，记 localStorage。
 *           菜单弹层挂到 body（position:absolute），不受顶栏 zoom 影响——否则一边拖一边缩，
 *           滑块会跟着顶栏一起缩小/位移，从鼠标底下跑掉。
 * 快照：保存工作流时记录 [后端 + 所有节点参数(含图像) + 画布布局] 到**服务端**
 *       user/AccelSwitch/snapshots.json；跨浏览器 / 清缓存不丢。
 *       画布布局 = 每个节点的 pos/size/order + 全部连线（两端用「类型#序号」身份键、
 *       插槽按名字匹配），恢复时先断开快照覆盖范围内的连线再按快照重建 ——
 *       保存时没接的线，恢复后也还是没接；位置/大小一起回到保存那一刻。
 *       打开工作流自动套用保存时的后端；菜单「↺」一键恢复（参数 + 连线 + 位置，不改后端）。
 *       顶栏缩放只记录、不随恢复套用（由滑块自己控制）。
 * 模板：常用参数模板按**工作流隔离**存服务端 presets.json；菜单一键填回当前画布。
 * 上一个任务：拦截 POST /prompt 记下真正执行的那份任务（刷新后回退查 /history），
 *       菜单可「原样重跑」「换随机种子重跑」「把参数填回画布」「复制 API 参数」。
 *       「填回画布」按**工作流分开记**：A 跑完再跑 B，回 A 填回的仍是 A 那次（jobsByWorkflow）。
 *       Ctrl+Alt+P 重跑，Ctrl+Alt+Shift+P 换种子重跑。
 * 「无」选项：给所有能加载图像 / 视频 / 音频的节点的文件下拉列表最前面加一个「无」，
 *       用于把这类节点显式置空（原生节点没有空选项）；选「无」会顺带清掉残留画面。
 *       Ctrl+Alt+A 切换后端，Ctrl+Alt+R 恢复快照。
 * 跑分：合成注意力负载测各可用后端，结果同时写入 ComfyUI 日志 + 界面弹窗。
 * 数据接口见 custom_nodes/ComfyUI-AccelSwitch/__init__.py。
 */

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const API = "./accel_switch";
const SNAP_API = "./accel_switch_snapshots";
const PRESET_API = "./accel_switch_presets";
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
let presets = {};            // 常用参数模板 -> {name: {values:[...]}}，服务端持久化

// ---------------------------------------------------------------- 顶栏缩放

const ZOOM_KEY = "Comfy.AccelSwitch.TopbarZoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1;
const ZOOM_STEP = 0.05;
let zoomValue = 0.8;

/** 夹紧到滑块范围并按步长取整，避免浮点误差（如 0.7000000000000001）。 */
function clampZoom(z) {
  const n = Number(z);
  if (!isFinite(n)) return zoomValue;
  const stepped = Math.round(n / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(stepped.toFixed(2))));
}

function loadZoom() {
  try {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (isFinite(v)) zoomValue = clampZoom(v);
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

/**
 * 设置顶栏缩放。
 * @param live=true 拖动滑块中 / 松手提交：只应用 CSS + 更新滑块读数，不 render
 *        （render 会重建 popup DOM、销毁正在拖动的 input，导致拖动中断）。
 *        恢复快照等其他入口仍传 false 走完整 render。
 */
function setZoom(z, live = false) {
  zoomValue = clampZoom(z);
  saveZoom();
  applyZoom();
  if (live) {
    updateZoomSliderUI();
  } else {
    log("顶栏缩放:", Math.round(zoomValue * 100) + "%");
    render();
  }
}

/** 拖动中就地更新滑块数值显示，不触碰 DOM 结构。 */
function updateZoomSliderUI() {
  try {
    const range = document.getElementById("accel-switch-zoom-range");
    const label = document.getElementById("accel-switch-zoom-value");
    const pct = Math.round(zoomValue * 100);
    if (range && Number(range.value) !== pct) range.value = String(pct);
    if (label) label.textContent = pct + "%";
  } catch { /* 忽略 */ }
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

async function apiGetPresets(workflow) {
  const qs = workflow ? ("?workflow=" + encodeURIComponent(workflow)) : "";
  const r = await fetch(PRESET_API + qs, { method: "GET" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return j.presets || {};
}

async function apiEditPreset(action, name, preset, workflow) {
  const body = { action, name, workflow };
  if (preset) body.preset = preset;
  const r = await fetch(PRESET_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  if (j.presets) presets = j.presets;
  return j;
}

/** 工作流改名 / 另存为后，把模板归属迁到新路径。 */
async function apiMovePresets(from, to) {
  const r = await fetch(PRESET_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "move", from, to }),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  if (_presetLoadedKey === from) _presetLoadedKey = to;
  await loadPresetsFromServer();
  await render();
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

/**
 * 写 localStorage 前把 layout（连线 + 位置）剥掉。
 * localStorage 有独立的 ~5MB 硬上限，一份大工作流的连线表就能占到几百 KB，
 * 十几个工作流叠加会把「保存工作流草稿」挤爆（这坑踩过）。
 * layout 只留在内存 + 服务端，刷新页面后由 loadSnapshotsFromServer 补回。
 */
function stripSnapshotLayout(snap) {
  if (!snap || !snap.layout) return snap;
  const { layout, ...rest } = snap;
  return rest;
}

function cacheSnapshotLocal(snap) {
  lastSnapshot = snap;
  snapshots[snap.file] = snap;
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(stripSnapshotLayout(snap)));
    const light = {};
    for (const [k, v] of Object.entries(snapshots || {})) light[k] = stripSnapshotLayout(v);
    localStorage.setItem(SNAP_MAP_KEY, JSON.stringify(light));
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
    // 合并而不是整体替换：刚保存但 POST 还没落地（或失败了）的那份要留住，
    // 否则会出现「我刚保存了，点恢复却说本工作流没有快照」。
    const merged = { ...fromServer };
    for (const [f, s] of Object.entries(snapshots || {})) {
      if (!s) continue;
      const srv = merged[f];
      if (!srv) { merged[f] = s; continue; }
      // 服务端那份可能是旧版本写的（没有 layout），或刚保存还没落地：
      // 本地有更新的 layout 就补上，别让「刚存过」变成「没有连线数据」。
      if (!srv.layout && s.layout && (s.savedAt || 0) >= (srv.savedAt || 0)) {
        merged[f] = { ...srv, layout: s.layout };
      }
    }
    snapshots = merged;
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

// ---------------------------------------------------------------- 画布布局（连线 + 位置）
//
// 「恢复」不只是把参数写回去，而是要把画布还原成保存那一刻的样子：
//   保存时某根线没接 → 恢复后它还是没接；节点的位置/大小/层级也一样。
//
// 做法：快照里额外存一份 layout —— 每个节点的 pos/size/order，加上全部连线。
// 连线两端用「类型#序号」身份键表示（不用数字 id，id 跨会话会重排），
// 插槽优先用名字匹配（索引兜底），这样节点 id 变了也不会接错口。
//
// 恢复时先把当前画布上的连线全部断开，再按 layout 一根根重建 ——
// 「断开」这一步正是「保存时没接的线恢复后也不接」的实现方式。

/** 采集当前画布的布局：节点位置/大小/层级 + 全部连线。 */
function captureLayout() {
  try {
    const graph = app?.graph;
    if (!graph || !Array.isArray(graph.nodes)) return null;
    const nodes = graph.nodes.slice();
    const ids = nodeIdentity(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const items = [];
    for (const n of nodes) {
      const identity = ids.get(n.id);
      if (!identity) continue;
      items.push({
        identity,
        type: String(n.type || ""),
        pos: Array.isArray(n.pos) ? [Math.round(n.pos[0]), Math.round(n.pos[1])] : null,
        size: Array.isArray(n.size) ? [Math.round(n.size[0]), Math.round(n.size[1])] : null,
        order: Number(n.order) || 0,
      });
    }
    let raw = [];
    try {
      raw = (graph.links instanceof Map)
        ? [...graph.links.values()]
        : Object.values(graph.links || {});
    } catch { raw = []; }
    const links = [];
    for (const l of raw) {
      const on = l?.origin_id ?? l?.origin_node;
      const tn = l?.target_id ?? l?.target_node;
      const a = byId.get(on), b = byId.get(tn);
      if (!a || !b) continue;
      const os = Number(l.origin_slot ?? 0), ts = Number(l.target_slot ?? 0);
      links.push({
        from: ids.get(on), from_slot: os, from_name: a.outputs?.[os]?.name ?? null,
        to: ids.get(tn), to_slot: ts, to_name: b.inputs?.[ts]?.name ?? null,
        type: l.type ?? a.outputs?.[os]?.type ?? null,
      });
    }
    return { capturedAt: Date.now(), nodes: items, links };
  } catch (e) {
    warn("采集画布布局失败:", e.message || e);
    return null;
  }
}

/** 按名字找一个插槽的索引，找不到再用快照里的索引兜底。 */
function slotIndexByName(slots, name, fallback) {
  if (!Array.isArray(slots)) return -1;
  if (name) {
    const i = slots.findIndex((s) => s && s.name === name);
    if (i >= 0) return i;
  }
  if (Number.isInteger(fallback) && fallback >= 0 && fallback < slots.length) return fallback;
  return -1;
}

/**
 * 把画布布局套回当前图：断开「快照覆盖范围内」的连线 → 按 layout 重建 → 摆位置。
 *
 * 关键语义：
 *  - 只有「两端节点都在快照里」的连线才回放。保存之后你新加的节点、以及它
 *    连出去的线保持原样，不会被这次恢复拆掉。
 *  - 快照里没有记录的线（保存时就没接）重建后自然还是没接 —— 这正是
 *    「保存时没接的线，恢复后也不接」的实现方式。
 *  - 快照要接的输入口如果被别的线占着（比如新节点接上去过），以快照为准，
 *    先挤掉再按快照接回来。
 * @returns {placed, missing, linksTotal, linksOk, linksFail, linksMissing} | null
 */
function applyCanvasLayout(layout) {
  const graph = app?.graph;
  if (!graph || !layout || !Array.isArray(layout.nodes)) return null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.slice() : [];
  const ids = nodeIdentity(nodes);
  const byIdentity = new Map();
  for (const n of nodes) {
    const k = ids.get(n.id);
    if (k && !byIdentity.has(k)) byIdentity.set(k, n);
  }
  const stat = {
    placed: 0, missing: 0, kept: 0,
    linksTotal: (layout.links || []).length,
    linksOk: 0, linksFail: 0, linksMissing: 0,
  };
  // 快照覆盖的节点身份集合
  const covered = new Set((layout.nodes || []).map((it) => it.identity));

  // 1) 只断开「两端都在快照里」的连线；新节点参与的线留着
  try {
    const raw = (graph.links instanceof Map)
      ? [...graph.links.values()]
      : Object.values(graph.links || {});
    for (const l of raw) {
      const fromId = ids.get(l?.origin_id ?? l?.origin_node);
      const toId = ids.get(l?.target_id ?? l?.target_node);
      if (!fromId || !toId) continue;
      if (!covered.has(fromId) || !covered.has(toId)) { stat.kept++; continue; }
      try { graph.removeLink?.(l?.id ?? l); } catch { /* 单条失败忽略 */ }
    }
  } catch (e) {
    warn("断开旧连线失败:", e.message || e);
  }
  // 兜底：覆盖范围内、link 已经不在 graph.links 里但槽位还留着的残渣，清掉。
  // 注意不能无脑断——保存后新增节点接进来的线是要保留的。
  for (const n of nodes) {
    const ident = ids.get(n.id);
    if (!ident || !covered.has(ident)) continue;
    const ins = Array.isArray(n.inputs) ? n.inputs : [];
    for (let i = 0; i < ins.length; i++) {
      const lid = ins[i]?.link;
      if (lid == null) continue;
      const alive = (graph.links instanceof Map)
        ? graph.links.has(lid)
        : !!(graph.links || {})[lid];
      if (alive) continue; // 还在 → 是保留下来的线
      try { n.disconnectInput?.(i); } catch { /* 忽略 */ }
    }
  }

  // 2) 按 layout 重建连线
  for (const l of (layout.links || [])) {
    const a = byIdentity.get(l.from), b = byIdentity.get(l.to);
    if (!a || !b) { stat.linksMissing++; continue; }
    const oi = slotIndexByName(a.outputs, l.from_name, l.from_slot);
    const ii = slotIndexByName(b.inputs, l.to_name, l.to_slot);
    if (oi < 0 || ii < 0) { stat.linksFail++; continue; }
    // 目标输入被占（可能是保存后新接的线）→ 以快照为准，先断开
    if (b.inputs?.[ii]?.link != null) {
      try { b.disconnectInput(ii); } catch { /* 忽略 */ }
    }
    let ok = false;
    try { ok = a.connect(oi, b, ii) !== false; } catch { ok = false; }
    // 有的版本 connect 成功也返回 undefined，直接看槽位上有没有 link
    if (!ok) ok = b.inputs?.[ii]?.link != null;
    if (ok) stat.linksOk++; else stat.linksFail++;
  }

  // 3) 位置 / 大小 / 层级
  for (const it of (layout.nodes || [])) {
    const n = byIdentity.get(it.identity);
    if (!n) { stat.missing++; continue; }
    try {
      if (Array.isArray(it.pos)) n.pos = [it.pos[0], it.pos[1]];
      if (Array.isArray(it.size) && Array.isArray(n.size)) n.size = [it.size[0], it.size[1]];
      if (Number.isFinite(it.order)) n.order = it.order;
      stat.placed++;
    } catch { /* 单节点失败忽略 */ }
  }

  try { graph.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  return stat;
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
    // 画布布局（连线 + 位置）：恢复时用来把画布也还原成保存那一刻的样子
    layout: captureLayout(),
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
    const prevWorkflow = currentWorkflowKey(); // 保存前的工作流标识，用于迁移模板
    const response = await original(route, init);
    // 抓 POST /prompt：记下这次提交的完整任务，供「重跑上一个 / 复制参数」
    if (method === "POST" && String(route).split("?")[0] === "/prompt" && response?.ok) {
      captureLastJob(init);
    }
    try {
      if (!file || !response || response.ok === false) return response;
      trackedWorkflowFile = file; // 模板按工作流隔离时的兜底标识
      if (method === "POST") {
        // 直接读画布当前状态，比解析 body 更可靠（body 格式随前端版本变化）
        captureSnapshot(file);
        // 另存为 / 改名：等前端把 activeWorkflow.path 更新完，再迁移模板归属
        setTimeout(async () => {
          try {
            const nowKey = currentWorkflowKey();
            if (!nowKey || nowKey === prevWorkflow) return;
            log("工作流路径变化，迁移参数模板:", prevWorkflow, "->", nowKey);
            await apiMovePresets(prevWorkflow, nowKey);
          } catch (e) {
            warn("迁移参数模板失败:", e.message || e);
          }
        }, 600);
      } else if (method === "GET") {
        // 打开工作流时套用它自己的快照：同样只认同一个文件（归一化比较兜路径差异）
        const snap = snapshots[file]
          || Object.keys(snapshots).map((f) => snapshots[f]).find((s) => sameWorkflow(s?.file, file));
        if (snap) {
          log("打开工作流，自动套用保存时的加速后端:", file);
          if (snap.backend && snap.backend !== state.current) {
            try {
              await choose(snap.backend);
            } catch (e) {
              warn("自动套用加速后端失败:", e.message || e);
            }
          }
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

/** 是否图像"输出/保存/预览"类节点（SaveImage / PreviewImage 等）。
 *  这类节点的预览是运行结果，存在 node.imgs + nodeOutputStore，不随快照保存；
 *  恢复时若快照无真实图源，也应清掉当前残留预览，和加载图像保持一致。 */
function isMediaOutput(type) {
  const t = String(type || '').toLowerCase();
  return ['saveimage', 'previewimage', 'saveanimatedwebp', 'saveanimatedgif',
          'savevideo', 'imagewriter', 'saveimagewebserver'].includes(t)
    || (t.includes('save') && t.includes('image'))
    || (t.includes('preview') && (t.includes('image') || t.includes('video')));
}

// ---------------------------------------------------------------- 媒体节点的「无」选项

/**
 * 给所有「能加载图像 / 视频 / 音频」的节点，在文件下拉列表最前面加一个「无」。
 *
 * 为什么需要：ComfyUI 原生加载节点只能选文件，没有"空"这个选项（只有孤海那种
 * 自定义节点自带「无」）。但"空图"是你工作流里真实存在的状态（保存时本来就是
 * 空的），恢复快照、临时置空重来都需要能表达它。
 *
 * 两条通道互补：
 *   1) beforeRegisterNodeDef —— 改 nodeData 里 combo 的取值数组，之后新建/加载的
 *      节点都带上（LiteGraph 建 widget 时的数据源）；
 *   2) nodeCreated + 看门狗 —— 前端「刷新节点定义」会把 widget.options.values
 *      整个换掉，这里兜底再补一次（幂等，已存在就跳过）。
 */
const NONE_OPTION = "无";
const MEDIA_FILE_RE = /\.(png|jpe?g|jfif|webp|bmp|gif|tiff?|avif|heic|heif|ico|mp4|webm|mov|mkv|avi|m4v|flv|wmv|mpe?g|mp3|wav|flac|ogg|oga|m4a|aac|opus)$/i;
const MODEL_FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|pkl|sft)$/i;
const MEDIA_INPUT_NAME_RE = /^(image|images|video|videos|audio|audios|file|files|filename|file_path|image_path|video_path|audio_path|audio_file|video_file|mask|mask_image|inpaint_image|reference_image|face_image)$/i;
const MEDIA_CATEGORY_RE = /^(image|video|audio|animation|loaders?)/i;

/** 这个 combo 是不是「选媒体文件」的？模型权重列表一律不碰。 */
function comboWantsNone(nodeData, inputName, values) {
  if (!Array.isArray(values)) return false;
  const strs = values.filter((v) => typeof v === "string");
  if (strs.some((v) => MODEL_FILE_RE.test(v))) return false;   // Checkpoint / LoRA / VAE…
  if (strs.some((v) => MEDIA_FILE_RE.test(v))) return true;    // 列表里已经有媒体文件
  if (!MEDIA_INPUT_NAME_RE.test(String(inputName || ""))) return false;
  const cat = String(nodeData?.category || "");
  if (MEDIA_CATEGORY_RE.test(cat)) return true;
  const type = String(nodeData?.name || nodeData?.type || nodeData?.comfyClass || "");
  return /(image|video|audio)/i.test(type) && /(load|read|导入|加载)/i.test(type);
}

/** 把一个媒体加载节点清成空图状态（widget 值已经是「无」/空时才调）。 */
function clearMediaNodeToEmpty(node) {
  if (!node) return;
  clearStaleMediaPreview(node);
  const store = getNodeOutputStore();
  try {
    if (store && typeof store.removeNodeOutputsForNode === "function") {
      store.removeNodeOutputsForNode(node);
    }
  } catch { /* 忽略 */ }
  forceGoohaiEmpty(node); // 孤海内部 displayed 必须走它自己的清空链
  setTimeout(() => {
    try { clearStaleMediaPreview(node); forceGoohaiEmpty(node); } catch { /* 忽略 */ }
  }, 250);
  setTimeout(() => { try { clearStaleMediaPreview(node); } catch { /* 忽略 */ } }, 900);
  try { node.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  try { node.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
}

/** 选中「无」时清掉残留画面：包一层 widget 回调，原有回调照常执行。 */
function wrapNoneCallback(node, w) {
  if (!w || w.__accelNoneWrapped) return;
  w.__accelNoneWrapped = true;
  const orig = w.callback;
  w.callback = function (v, ...rest) {
    let out;
    try {
      out = typeof orig === "function" ? orig.call(this, v, ...rest) : undefined;
    } catch (e) {
      warn("原 widget 回调出错（已忽略）:", e.message || e);
    }
    try {
      if (isEmptyMediaValue(v)) {
        log("选中「无」，清空节点画面:", node?.type, "#" + node?.id);
        clearMediaNodeToEmpty(node);
      }
    } catch (e) {
      warn("清空媒体节点失败:", e.message || e);
    }
    return out;
  };
}

/** 给单个 widget 补「无」（幂等），返回是否新加了。 */
function ensureNoneInWidget(node, w) {
  const values = w?.options?.values;
  if (!Array.isArray(values)) return false;
  if (values.includes(NONE_OPTION)) {
    wrapNoneCallback(node, w); // 已带「无」的（如孤海）也要补"选无→清画面"的钩子
    return false;
  }
  // widget 层面拿不到节点 category，用节点类型是否属于加载类来兜底判断
  const nodeData = { name: node?.type, category: isMediaLoader(node?.type) ? "image" : "" };
  if (!comboWantsNone(nodeData, w.name, values)) return false;
  values.unshift(NONE_OPTION);
  wrapNoneCallback(node, w);
  log("已加「无」选项:", node?.type, "|", w.name);
  return true;
}

/** nodeData 层面补「无」：影响之后所有新建 / 加载出来的节点。 */
function patchNodeDefCombo(nodeData) {
  if (!nodeData || !nodeData.input) return 0;
  let n = 0;
  for (const group of ["required", "optional"]) {
    const spec = nodeData.input[group];
    if (!spec || typeof spec !== "object") continue;
    for (const [name, def] of Object.entries(spec)) {
      const values = Array.isArray(def) ? def[0] : null;
      if (!Array.isArray(values) || values.includes(NONE_OPTION)) continue;
      if (!comboWantsNone(nodeData, name, values)) continue;
      values.unshift(NONE_OPTION);
      n++;
    }
  }
  if (n) log("节点定义已补「无」选项:", nodeData.name, "|", n, "个输入");
  return n;
}

/** 节点实例层面补「无」（前端刷新 node defs 后兜底）。 */
function patchNodeComboWidgets(node) {
  if (!node || !Array.isArray(node.widgets)) return 0;
  let n = 0;
  for (const w of node.widgets) {
    if (ensureNoneInWidget(node, w)) n++;
  }
  return n;
}

/** 给画布上所有存量节点补一次「无」。 */
function patchAllNodeWidgets() {
  let n = 0;
  try {
    const graph = app.graph;
    const nodes = graph?._nodes || graph?.nodes || [];
    for (const node of nodes) n += patchNodeComboWidgets(node);
  } catch (e) {
    warn("批量补「无」失败:", e.message || e);
  }
  return n;
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
 * 清空图像"输出/保存/预览"节点（SaveImage / PreviewImage 等）的当前预览。
 * 这类节点的图是运行结果，存在 node.imgs + nodeOutputStore，不随快照保存；
 * 恢复时要和加载图像一样清掉，否则"加载图像清空了、保存图像还挂着旧图"。
 */
function clearOutputNodePreview(node) {
  if (!isMediaOutput(node.type)) return;
  const store = getNodeOutputStore();
  try {
    if (store && typeof store.removeNodeOutputsForNode === "function") {
      store.removeNodeOutputsForNode(node);
    }
  } catch { /* 忽略 */ }
  clearStaleMediaPreview(node); // node.imgs=null + DOM 覆盖层
  try { node.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  try { node.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  // configure 的异步输出回放可能晚到，延迟再清一次
  setTimeout(() => {
    try { if (store && typeof store.removeNodeOutputsForNode === "function") store.removeNodeOutputsForNode(node); } catch { /* 忽略 */ }
    clearStaleMediaPreview(node);
  }, 300);
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
const _diagPreview = { store: false, nodes: 0, loaded: 0, urls: 0, cleared: 0, outputsCleared: 0 };
/** 上一次恢复里，有多少节点被改回「旁通/忽略」——用于提示"这是保存时的状态"。 */
let _lastModeChanged = 0;
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
 * widget 值是不是「显式空」（借 Goohai 的约定："" 与 "无" 都算空）。
 * 我们自己给所有媒体加载节点的下拉列表加了「无」，所以解析图像值时必须先拦这一档，
 * 否则会拿字符串 "无" 去拼 /view?filename=无，加载失败、旧图继续挂着。
 */
function isEmptyMediaValue(v) {
  const s = String(v ?? "").trim();
  return s === "" || s === "无";
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

  // ★ 值是「无」/空：这是我们给所有媒体节点加的空选项，直接按空图处理。
  //   必须在这里拦住——否则下面会拿 "无" 去 setNodeOutputs + 拼 /view URL，
  //   加载失败后旧图继续挂着，看起来像"没生效"。
  if (isEmptyMediaValue(value)) {
    _diagPreview.cleared++;
    clearMediaNodeToEmpty(node);
    log("媒体节点处于「无」，按空图恢复:", node.type);
    return;
  }

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
 * 分组控制类节点（孤海「忽略多组」/ Fast Groups Muter 之类）。
 * 它们本身不参与出图，而是读其它节点的 mode 推导「每组是开还是关」，
 * 再由点击去批量改 mode。所以恢复快照时：
 *   - 绝不能把它们自己恢复成忽略(2)/旁通(4)，否则整个分组开关就"失效"；
 *   - 必须放在最后恢复，让它们 onConfigure 时看到的是其它节点已还原完的状态。
 */
const GROUP_CONTROLLER_RE = /忽略多组|多组孤海|fast\s*groups|groups?\s*(muter|bypasser)/i;
function isGroupControllerNode(node, item) {
  const type = String(node?.type || item?.type || "");
  if (GROUP_CONTROLLER_RE.test(type)) return true;
  const props = node?.properties || item?.properties || {};
  return Object.keys(props || {}).some((k) => k.startsWith("guhai_ig_"));
}

/**
 * 套用快照设置。
 * withNodes=true 时恢复节点参数——但严格按「类型 + 同类型序号」匹配，
 * 绝不按数字 id（id 跨工作流会撞车，导致把 A 节点的值套给 B 节点）。
 * 只恢复节点参数 / 旁通状态，不碰加速后端与顶栏缩放。
 */
async function applySnapshotSettings(snap, withNodes = true, expectFile = null) {
  if (!snap) return 0;
  // 归属校验：只允许把「这个文件自己的快照」套到它身上。
  // 跨文件套用会把别的工作流的 widget 值 / properties / 预览图按
  // 「同类型同序号」写进来，画布看上去就成了另一个工作流的内容。
  if (expectFile && snap.file && !sameWorkflow(snap.file, expectFile)) {
    warn("已阻止跨工作流套用快照:", snap.file, "≠", expectFile);
    return 0;
  }
  let matched = 0;
  let modeChanged = 0; // 本次真正把节点改回旁通/忽略的个数（用于提示"这是保存时的状态"）
  const skipped = [];
  _diagPreview.store = false; _diagPreview.nodes = 0; _diagPreview.loaded = 0; _diagPreview.urls = 0; _diagPreview.cleared = 0; _diagPreview.outputsCleared = 0;
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

      // 分组控制节点放最后恢复：这样它 onConfigure 时，其它节点的 mode 已经还原完，
      // 它推导出的"每组开关状态"才和画布一致，不会一恢复就变成"混合/失效"。
      const snapItems = (snap.nodes || []).slice();
      const orderedItems = [
        ...snapItems.filter((it) => !isGroupControllerNode(null, it)),
        ...snapItems.filter((it) => isGroupControllerNode(null, it)),
      ];

      for (const item of orderedItems) {
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

          // 分组控制节点永远保持「正常」：快照里若把它记成了忽略(2)/旁通(4)，
          // 一旦照抄，画布上那个分组开关就整体失效了（它的 UI 靠 mode 判断，
          // 自己变灰或旁通后点击不再生效）。
          const isCtrl = isGroupControllerNode(node, item);
          const snapMode = Number(item.mode ?? base.mode ?? 0) || 0;
          const restoreMode = isCtrl ? 0 : snapMode;
          const curMode = Number(node.mode) || 0;
          if (restoreMode !== curMode) modeChanged++;

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
            mode: restoreMode,
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
          // 图像输出/保存节点（SaveImage / PreviewImage 等）：预览是运行结果，
          // 不随快照保存，恢复时把当前残留预览也清掉，和加载图像保持一致。
          if (isMediaOutput(node.type)) {
            clearOutputNodePreview(node);
            _diagPreview.outputsCleared++;
          }
          try { node.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
          matched++;
        } catch (e) {
          warn("恢复节点 " + key + " 失败:", e.message || e);
        }
      }
      graph?.setDirtyCanvas?.(true, true);
      // 分组控制节点在最后再同步一次：此时全画布 mode 已还原完，
      // 它显示的"每组开关"才和实际一致（否则会卡在混合/半开状态）。
      for (const n of liveNodes) {
        if (typeof n?._guhaiSyncGroups === "function" && isGroupControllerNode(n, null)) {
          try { n._guhaiSyncGroups(); } catch { /* 忽略 */ }
        }
      }
      const realSkipped = skipped.filter((s) => !s.startsWith('used:'));
      if (realSkipped.length) log("恢复时跳过（安全校验）:", realSkipped.slice(0, 12).join(', '));
    } catch (e) {
      warn("恢复节点设置失败:", e.message || e);
    }
  }

  // 注：快照里的 zoom 只做记录，恢复时不再套用——顶栏缩放由用户用滑块自己控制，
  // 点「恢复」不应该把顶栏大小改回去（实测会被这个行为烦到）。
  // 注：快照里的 backend 同样只做记录，点「恢复」不改加速后端（后端由顶栏自己控制）。
  _lastModeChanged = modeChanged;
  log("已套用保存时的设置:", snap.file, "| 匹配节点:", matched,
      "| 状态改回:", modeChanged);
  return matched;
}

/**
 * 一键恢复：把画布还原成「当前工作流自己保存时」的样子。
 *  - 参数/旁通/图像：全部写回
 *  - 画布布局：连线（含没接的线）+ 节点位置/大小 一起还原
 *  - 顶栏缩放：不动（由滑块自己控制）
 *  - 加速后端：不动（由顶栏自己控制）
 */
async function restoreSnapshot() {
  // 每次都尝试拉一次服务端（权威来源，其它标签页新存的可能还没进内存）；
  // 拉失败就退回 localStorage 缓存 —— 别用 snapshotsLoaded 做前置判断，
  // 否则上一次加载失败会让恢复一直以为「本工作流没有快照」。
  try {
    await loadSnapshotsFromServer();
  } catch {
    /* 用现有缓存 */
  }
  const wk = currentWorkflowKey();
  if (!wk || wk === "__unsaved__") {
    warn("当前工作流还没存过盘，无法确定它属于哪份快照——请先保存工作流");
    flashNotice("先保存工作流", false);
    showResultPanel("无法定位当前工作流", [
      "当前工作流还没有保存到磁盘（没有文件路径），",
      "所以没法确定哪份快照属于它。",
      "",
      "为了不把别的工作流的参数套进来，这次什么也没改。",
      "先 Ctrl+S 保存一次，再点恢复。",
    ], false);
    return;
  }
  const snap = snapshotForCurrentWorkflow();
  if (!snap) {
    // 关键安全闸：没有本工作流的快照就什么都不做。
    // 以前这里用的是全局「最近保存」的那份，导致 A 的参数被套进 B。
    const other = otherLatestSnapshot();
    const lines = [
      "当前工作流: " + wk,
      "这个文件还没有快照，所以这次什么都没改。",
      "",
      "恢复只认「当前工作流自己的快照」，不会拿别的工作流最近保存的那份顶替。",
    ];
    if (other) {
      lines.push("");
      lines.push("最近保存的是另一个工作流（已跳过）:");
      lines.push("  " + other.file
        + (other.savedAt ? "（" + new Date(other.savedAt).toLocaleString() + "）" : ""));
    }
    lines.push("");
    lines.push("要在这个工作流上用快照：Ctrl+S 保存一次，再点恢复。");
    warn("当前工作流无快照，已拒绝跨工作流恢复:", wk,
         other ? "| 最近的是 " + other.file : "");
    flashNotice("本工作流无快照", false);
    showResultPanel("当前工作流还没有快照", lines, false);
    return;
  }
  // 双保险：即使 snapshotForCurrentWorkflow 出岔子，也不允许跨文件套用
  if (!sameWorkflow(snap.file, wk)) {
    warn("拒绝恢复：快照归属与当前工作流不符", snap.file, "≠", wk);
    flashNotice("快照不属于本工作流", false);
    showResultPanel("已拒绝恢复", [
      "快照文件: " + (snap.file || "-"),
      "当前工作流: " + wk,
      "",
      "两者不是同一个文件，套用会把别的画布内容写进来，已中止。",
    ], false);
    return;
  }
  const matched = await applySnapshotSettings(snap, true, wk);

  // 画布布局回放：连线（含"没接"的线）+ 节点位置/大小，一起回到保存那一刻。
  // 必须放在参数恢复之后——先接线再 configure 的话，万一某节点的 onConfigure
  // 重建插槽，刚接好的线就会被冲掉。
  let layoutStat = null;
  if (snap.layout) {
    layoutStat = applyCanvasLayout(snap.layout);
  }

  flashNotice("✓ 已恢复", true);
  log("恢复完成:", snap.file, "| 匹配节点:", matched, "| 状态改回:", _lastModeChanged,
      "| 布局:", layoutStat);
  const lines = [
    "工作流: " + snap.file,
    "恢复节点: " + matched + " 个",
    "保存时间: " + (snap.savedAt ? new Date(snap.savedAt).toLocaleString() : "-"),
  ];
  if (layoutStat) {
    const bad = [];
    if (layoutStat.linksFail) bad.push("连线接不上 " + layoutStat.linksFail + " 根");
    if (layoutStat.linksMissing) bad.push("节点已不在画布 " + layoutStat.linksMissing + " 根");
    if (bad.length) {
      lines.push("");
      lines.push("⚠ " + bad.join(" · ") + "（插槽改名或节点被删/换类型）");
    }
  } else {
    lines.push("");
    lines.push("⚠ 这份快照是旧版本存的，没有连线/位置数据：本次只恢复了参数。");
    lines.push("  Ctrl+S 保存一次后再点恢复，就能连画布一起还原。");
  }
  showResultPanel(layoutStat ? "画布与参数已恢复" : "设置已恢复", lines, true);
}

// ---------------------------------------------------------------- 上一个任务（重跑 / 复制参数）

/**
 * 上一个被提交的任务。来源两处：
 *  1) 拦截 POST /prompt 抓原始请求体（最准，就是服务端真正执行的那份 API prompt）
 *  2) 内存没有（如刷新过页面）时回退查服务端 /history
 * 只放内存不落 localStorage：一个大工作流的 API prompt 可能几百 KB，
 * 塞 localStorage 会把「保存工作流草稿」的 5MB 配额挤爆（这个坑踩过）。
 */
let lastJob = null; // {prompt, extra_data, at, source, id}

/**
 * 按工作流分开记「上一个任务」。
 * 场景：A 跑完 → B 跑完 → 回 A 点「填回画布」，必须拿 A 那次，不能拿 B 那次
 * （两份工作流的节点 id 都从 1 起，拿错了就会把 B 的参数按 id 写进 A）。
 * 只放内存：一份 API prompt 几百 KB，落 localStorage 会挤爆 5MB 配额。
 * 刷新页面后清空——这时宁可提示「本工作流还没有运行记录」，也不拿别的工作流的顶上。
 */
const jobsByWorkflow = new Map();
const JOB_WORKFLOW_LIMIT = 12;

/** 当前工作流的归一化 key（未保存的临时画布单独一档）。 */
function jobWorkflowKey() {
  const wk = currentWorkflowKey();
  return (wk && wk !== "__unsaved__") ? normWorkflowKey(wk) : "__unsaved__";
}

/** 记下这次提交的任务，同时挂到当前工作流名下。 */
function rememberJob(job) {
  lastJob = job;
  const k = jobWorkflowKey();
  jobsByWorkflow.delete(k); // 先删再插：Map 保持「最近使用」在末尾，方便淘汰
  jobsByWorkflow.set(k, job);
  while (jobsByWorkflow.size > JOB_WORKFLOW_LIMIT) {
    const oldest = jobsByWorkflow.keys().next().value;
    jobsByWorkflow.delete(oldest);
  }
}

/** 当前工作流自己的上一个任务（不跨工作流）。 */
function jobForCurrentWorkflow() {
  const job = jobsByWorkflow.get(jobWorkflowKey());
  return job?.prompt ? job : null;
}

/** 判断某个对象是不是 API 格式的 prompt（node_id -> {class_type, inputs}）。 */
function looksLikePromptDict(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const vals = Object.values(v);
  if (!vals.length) return false;
  return vals.every((n) => n && typeof n === "object" && typeof n.class_type === "string");
}

/** 从 /history 的队列元组里捞出 prompt + extra_data（兼容新旧两种元组顺序）。 */
function promptFromHistoryItem(item) {
  if (!Array.isArray(item)) return null;
  const max = Math.min(item.length - 1, 4);
  for (let i = 1; i <= max; i++) {
    if (!looksLikePromptDict(item[i])) continue;
    const next = item[i + 1];
    const extra = (next && typeof next === "object" && !Array.isArray(next)) ? next : {};
    return { prompt: item[i], extra_data: extra, at: Number(extra.create_time) || 0 };
  }
  return null;
}

/** 请求体里的任务记下来（供「重跑 / 复制参数」用）。 */
function captureLastJob(init) {
  try {
    const raw = init?.body;
    let body = null;
    if (typeof raw === "string") body = JSON.parse(raw);
    else if (raw && typeof raw === "object" && !(raw instanceof Blob) && !(raw instanceof FormData)) body = raw;
    if (!body || !looksLikePromptDict(body.prompt)) return;
    rememberJob({
      prompt: body.prompt,
      extra_data: body.extra_data || {},
      at: Number(body.extra_data?.create_time) || Date.now(),
      source: "hook",
    });
    log("已记录上一个任务:", Object.keys(body.prompt).length, "个节点",
        "| 工作流:", jobWorkflowKey());
    scheduleJobRender();
  } catch (e) {
    warn("记录上一个任务失败:", e.message || e);
  }
}

/** 运行记录变化后重绘一次菜单（合并抖动，避免每次提交都重建按钮）。 */
let jobRenderTimer = null;
function scheduleJobRender() {
  if (jobRenderTimer) return;
  jobRenderTimer = setTimeout(() => {
    jobRenderTimer = null;
    render().catch(() => {});
  }, 400);
}

function historyTs(entry) {
  const msgs = entry?.status?.messages;
  if (!Array.isArray(msgs)) return 0;
  let ts = 0;
  for (const m of msgs) {
    const t = Array.isArray(m) ? m[1]?.timestamp : m?.timestamp;
    if (typeof t === "number" && t > ts) ts = t;
  }
  return ts;
}

/** 最近一条历史（优先按时间戳，没有时间戳就按返回顺序的最后一条）。 */
function newestHistoryEntry(hist) {
  const ids = Object.keys(hist || {}).filter((k) => hist[k] && Array.isArray(hist[k].prompt));
  if (!ids.length) return null;
  let best = ids[ids.length - 1];
  let bestTs = 0;
  for (const k of ids) {
    const ts = historyTs(hist[k]);
    if (ts > 0 && ts > bestTs) { bestTs = ts; best = k; }
  }
  return { id: best, entry: hist[best] };
}

/** 取上一个任务：内存优先，否则查服务端 /history。 */
async function getLastJob() {
  if (lastJob?.prompt) return lastJob;
  try {
    const r = await api.fetchApi("/history?max_items=20");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const hist = await r.json();
    const pick = newestHistoryEntry(hist);
    const parsed = promptFromHistoryItem(pick?.entry?.prompt);
    if (!parsed) return null;
    lastJob = {
      prompt: parsed.prompt,
      extra_data: parsed.extra_data,
      at: parsed.at || historyTs(pick.entry) || 0,
      source: "history",
      id: pick.id,
    };
    log("从 /history 取到上一个任务:", pick.id, "|", Object.keys(parsed.prompt).length, "个节点");
    return lastJob;
  } catch (e) {
    warn("读取上一个任务失败:", e.message || e);
    return null;
  }
}

function randomSeed32() {
  return Math.floor(Math.random() * 4294967296); // 0 ~ 2^32-1，落在所有种子控件的取值范围内
}

/** 把 prompt 里所有 seed / noise_seed 之类输入换成新随机值（原地改，调用前先克隆）。 */
function randomizeSeeds(prompt) {
  const changed = [];
  for (const [id, node] of Object.entries(prompt || {})) {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const key of Object.keys(inputs)) {
      if (!/seed/i.test(key)) continue;
      if (typeof inputs[key] !== "number" || !isFinite(inputs[key])) continue;
      const old = inputs[key];
      const nv = randomSeed32();
      inputs[key] = nv;
      changed.push(`${node.class_type || id}.${key}: ${old} → ${nv}`);
    }
  }
  return changed;
}

/** 把入队失败时的 error / node_errors 拼成人能读的几行。 */
function formatPromptError(j, status) {
  const lines = [];
  const e = j?.error;
  if (e) {
    if (typeof e === "string") lines.push(e);
    else {
      lines.push(e.message || e.type || "入队被服务端拒绝");
      if (e.details) lines.push(String(e.details).slice(0, 500));
    }
  }
  for (const [id, ne] of Object.entries(j?.node_errors || {})) {
    const cls = ne?.class_type || "";
    const errs = ne?.errors || {};
    const keys = Object.keys(errs);
    if (!keys.length) { lines.push(`节点 ${id} ${cls}: ${ne?.message || "参数无效"}`); continue; }
    for (const k of keys) {
      const v = errs[k] || {};
      lines.push(`节点 ${id} ${cls} · ${k}: ${v.message || v.details || "参数无效"}`);
    }
  }
  if (!lines.length) lines.push("HTTP " + status + " " + JSON.stringify(j).slice(0, 300));
  return lines.join("\n");
}

/** 直接 POST /prompt 入队（client_id 用当前浏览器，进度/预览才会推到这里）。 */
async function enqueuePrompt(prompt, extraData) {
  const body = {
    // 前端也是用同一个 sid 当 client_id；socket 还没握手完时用 window.name 兜底
    client_id: api?.clientId || window.name || "",
    prompt,
    extra_data: extraData || {},
  };
  const r = await api.fetchApi("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  const nodeErrCount = Object.keys(j?.node_errors || {}).length;
  if (!r.ok || j?.error || nodeErrCount) throw new Error(formatPromptError(j, r.status));
  return j;
}

/** 简短描述一份 prompt：节点数、主要类型、种子值。 */
function describePrompt(prompt) {
  const ids = Object.keys(prompt || {});
  const counts = {};
  const seeds = [];
  for (const id of ids) {
    const n = prompt[id] || {};
    const t = n.class_type || "?";
    counts[t] = (counts[t] || 0) + 1;
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (/seed/i.test(k) && typeof v === "number") seeds.push(`${t}.${k} = ${v}`);
    }
  }
  const kinds = Object.keys(counts).length;
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t, c]) => (c > 1 ? `${t}×${c}` : t));
  const lines = [`节点数：${ids.length}（${top.join(", ")}${kinds > 8 ? " …" : ""}）`];
  if (seeds.length) lines.push("种子：" + seeds.join("; "));
  return lines;
}

function jobAgo(job) {
  if (!job?.at) return "";
  const s = Math.max(0, Math.round((Date.now() - job.at) / 1000));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前";
  return Math.round(s / 86400) + " 天前";
}

/**
 * 重跑上一个任务。
 * @param newSeed=true 把所有种子换成随机值（「再来一张」）；false 原样重跑（结果可复现）。
 */
async function rerunLast(newSeed) {
  const job = await getLastJob();
  if (!job?.prompt) {
    warn("没有可重跑的任务");
    flashNotice("无运行记录", false);
    showResultPanel("重跑上一个任务", [
      "没有找到可重跑的任务。",
      "抓取方式：提交任务时记内存（刷新页面后回退查 /history）。",
      "先正常点一次「运行」，之后这里就有记录了。",
    ], false);
    return;
  }
  const prompt = clone(job.prompt);
  const seedChanges = newSeed ? randomizeSeeds(prompt) : [];
  flashNotice(newSeed ? "重跑(新种子)…" : "重跑…", true);
  try {
    const j = await enqueuePrompt(prompt, clone(job.extra_data || {}));
    rememberJob({ prompt, extra_data: job.extra_data, at: Date.now(), source: "hook" });
    const lines = [
      "已入队：prompt_id " + (j.prompt_id || "(未返回)"),
      ...describePrompt(prompt),
      newSeed
        ? (seedChanges.length
          ? "已换随机种子：\n  " + seedChanges.join("\n  ")
          : "没找到数值型 seed 输入，已按原样重跑")
        : "参数与种子完全一致，结果应与上次相同",
      newSeed ? "任务参数已变更，如需保留请在画布上同步" : "提示：切后端后再重跑，可对比真实采样耗时（AccelLog）",
    ];
    log("重跑上一个任务:", lines.join(" | "));
    flashNotice("✓ 已入队", true);
    showResultPanel(newSeed ? "重跑上一个任务（新种子）" : "重跑上一个任务（同参数）", lines, true);
  } catch (e) {
    warn("重跑失败:", e.message || e);
    flashError();
    showResultPanel("重跑失败", String(e.message || e).split("\n"), false);
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 非安全上下文或没有用户手势，走下面的兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    Object.assign(ta.style, { position: "fixed", top: "-1000px", opacity: "0" });
    (document.body || document.documentElement).appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 复制上一个任务的 API 格式参数（JSON）到剪贴板，并打印到 console。 */
async function copyLastParams() {
  const job = await getLastJob();
  if (!job?.prompt) {
    flashNotice("无运行记录", false);
    showResultPanel("复制上一个任务参数", ["没有找到可复制的任务，先运行一次。"], false);
    return;
  }
  const text = JSON.stringify(job.prompt, null, 2);
  const ok = await copyText(text);
  console.log(LOG_TAG, "上一个任务参数(API 格式):", job.prompt);
  log("已复制上一个任务参数:", text.length, "字符 |", Object.keys(job.prompt).length, "个节点");
  flashNotice(ok ? "✓ 已复制" : "⚠ 复制失败", ok);
  showResultPanel("上一个任务参数（API 格式）", [
    ...describePrompt(job.prompt),
    "提交时间：" + (job.at ? new Date(job.at).toLocaleString() : "未知"),
    "",
    ok
      ? "✓ 已复制到剪贴板（" + text.length + " 字符）"
      : "✗ 剪贴板不可用，完整 JSON 已打印到 F12 console",
  ], ok);
}

/**
 * 把「当前工作流上一次运行」的参数填回画布。
 *
 * 归属：只取本工作流自己的那次任务（jobsByWorkflow），不会拿别的工作流的顶上。
 * 匹配规则：节点 id 相同 **且** class_type 相同才算命中（双重校验，防止把 A 节点的
 * 值写到 B 节点上）。只写 widget 值，不碰连线——prompt 里数组形式的输入就是连线，
 * 直接跳过（本功能不改图结构）。
 */
async function applyLastJobToCanvas() {
  // 只认「当前工作流自己」的那次任务：A 跑完再跑 B，回 A 填回时用的仍是 A 那次。
  const job = jobForCurrentWorkflow();
  if (!job?.prompt) {
    flashNotice("本工作流无运行记录", false);
    showResultPanel("把上一个任务的参数填回画布", [
      "当前工作流还没有运行记录，没有参数可填。",
      "",
      "这个功能按工作流分开记（A 的只填回 A，不会串到 B）。",
      "记录只存在本次页面会话里，刷新会清空——先在这个工作流点一次「运行」。",
    ], false);
    return;
  }
  const graph = app.graph;
  const liveNodes = Array.isArray(graph?.nodes) ? graph.nodes.slice() : (graph?._nodes || []);
  if (!liveNodes.length) {
    flashNotice("画布是空的", false);
    showResultPanel("把上一个任务的参数填回画布", ["当前画布没有节点。"], false);
    return;
  }

  const used = new Set();
  const typeMismatch = [];
  let matchedNodes = 0, wroteNodes = 0, wroteParams = 0, skippedParams = 0;

  for (const node of liveNodes) {
    const key = String(node.id);
    const entry = job.prompt[key];
    if (!entry) continue;
    if (String(entry.class_type || "") !== String(node.type || "")) {
      typeMismatch.push(`#${key}: 任务是 ${entry.class_type}，画布是 ${node.type}`);
      continue;
    }
    used.add(key);
    matchedNodes++;
    const widgets = Array.isArray(node.widgets) ? node.widgets : [];
    let nodeWrote = 0;
    for (const [name, val] of Object.entries(entry.inputs || {})) {
      if (Array.isArray(val)) continue; // 连线输入，不动
      const w = widgets.find((x) => x && x.name === name);
      if (!w || w.serialize === false) { skippedParams++; continue; }
      let same = false;
      try { same = JSON.stringify(w.value) === JSON.stringify(val); } catch { same = false; }
      if (same) continue;
      try {
        notifyWidgetChange(node, w, clone(val));
        nodeWrote++;
      } catch (e) {
        warn(`写节点 #${key}.${name} 失败:`, e.message || e);
        skippedParams++;
      }
    }
    if (nodeWrote) {
      wroteNodes++;
      wroteParams += nodeWrote;
      // 媒体节点的预览跟着补一次（值是「无」就清画面，否则重绘）
      if (isMediaLoader(node.type)) {
        try {
          if (isEmptyMediaValue(imageWidgetValue(node))) clearMediaNodeToEmpty(node);
          else refreshMediaPreview(node, {});
        } catch (e) { warn("刷新媒体预览失败:", e.message || e); }
      }
    }
  }

  const promptNodeCount = Object.keys(job.prompt).length;
  const missing = Object.keys(job.prompt).filter((k) => !used.has(k));
  try { graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }

  const lines = [
    `任务来源：本工作流上一次运行（${job.at ? new Date(job.at).toLocaleString() : "时间未知"}）`,
    `命中节点：${matchedNodes} / ${promptNodeCount}（id + 类型都对上才写）`,
    `写入参数：${wroteParams} 项，涉及 ${wroteNodes} 个节点`,
  ];
  if (skippedParams) lines.push(`跳过：${skippedParams} 项（当前节点没有同名参数）`);
  if (missing.length) lines.push(`任务里有、画布上没有的节点：${missing.length} 个（${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}）`);
  if (typeMismatch.length) lines.push(`类型不符跳过：${typeMismatch.slice(0, 5).join("；")}${typeMismatch.length > 5 ? " …" : ""}`);
  lines.push("");
  if (!matchedNodes) {
    lines.push("✗ 一个节点都没对上——当前画布多半不是产生这个任务的那份工作流（节点 id 对不上）。");
  } else if (matchedNodes < promptNodeCount * 0.6) {
    lines.push("⚠ 命中率偏低，画布可能和这个任务不是同一份工作流，请检查结果是否符合预期。");
  } else {
    lines.push("✓ 已把参数填回画布（未改连线、未改加速后端、未改顶栏缩放）");
  }
  log("把上一个任务参数填回画布:", lines.join(" | "));
  flashNotice(matchedNodes ? "✓ 参数已填回" : "⚠ 未命中", matchedNodes > 0);
  showResultPanel("把上一个任务的参数填回画布", lines, matchedNodes > 0);
}

// ---------------------------------------------------------------- 常用参数模板

/** 当前工作流标识（模板按工作流隔离）。优先问前端 workflow store，兜底用保存钩子看到的路径。 */
let trackedWorkflowFile = null;
let _workflowStoreCached = null;
function getWorkflowStore() {
  if (_workflowStoreCached && "activeWorkflow" in _workflowStoreCached) return _workflowStoreCached;
  try {
    const el = document.querySelector("#vue-app");
    const pinia = el?.__vue_app__?.config?.globalProperties?.$pinia;
    const stores = pinia?._s;
    if (stores) {
      for (const id of ["workflow", "workflowStore"]) {
        const s = stores.get?.(id);
        if (s && "activeWorkflow" in s) { _workflowStoreCached = s; return s; }
      }
      for (const s of (stores.values?.() || [])) {
        if (s && "activeWorkflow" in s && "openWorkflows" in s) {
          _workflowStoreCached = s;
          return s;
        }
      }
    }
  } catch { /* 忽略 */ }
  return null;
}

function currentWorkflowKey() {
  try {
    const aw = getWorkflowStore()?.activeWorkflow;
    const p = aw?.path || aw?.key || aw?.filename;
    if (typeof p === "string" && p) return p;
  } catch { /* 忽略 */ }
  if (trackedWorkflowFile) return trackedWorkflowFile;
  return "__unsaved__";
}

/**
 * 归一化工作流标识，只用于「是不是同一个文件」的比较。
 * 快照 key 来自保存路由，形如 workflows/Krea2/四视图生成流-k2.json；
 * 前端 activeWorkflow.path 在不同版本 / 不同入口可能给纯文件名、带
 * user/default/ 的相对路径、甚至绝对路径，直接 === 会把同一个文件误判成两份。
 */
function normWorkflowKey(p) {
  if (typeof p !== "string" || !p) return "";
  let s = p.split("?")[0].split("#")[0].trim();
  try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
  s = s.replace(/\\/g, "/").replace(/^\.?\//, "");
  // 任意前缀里的 .../workflows/ 一律砍掉（兼容 user/default/workflows/ 与绝对路径）
  const i = s.toLowerCase().lastIndexOf("workflows/");
  if (i >= 0) s = s.slice(i + "workflows/".length);
  return s.replace(/^\/+/, "").toLowerCase();
}

/** 归一化后的文件名（不含目录）。 */
function workflowBaseName(p) {
  const n = normWorkflowKey(p);
  return n ? n.split("/").pop() : "";
}

/** 两个工作流标识是否指向同一个文件（仅文件名时可退化为同名比较）。 */
function sameWorkflow(a, b) {
  const na = normWorkflowKey(a);
  const nb = normWorkflowKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (!na.includes("/") || !nb.includes("/")) return workflowBaseName(na) === workflowBaseName(nb);
  return false;
}

/**
 * 当前工作流「自己」的快照 —— 恢复的唯一合法来源。
 *
 * 之前的 bug：restoreSnapshot() 直接用全局 lastSnapshot（所有工作流里 savedAt
 * 最大的那个），于是在 A 工作流保存过、切到 B 工作流点恢复，就会把 A 的节点
 * 参数 / properties / 预览图按「同类型同序号」套进 B —— 画布上看起来就是
 * "B 里的东西变成了别的工作流的"。恢复必须只认当前文件的快照，没有就不动。
 */
function snapshotForCurrentWorkflow() {
  const wk = currentWorkflowKey();
  if (!wk || wk === "__unsaved__") return null;
  if (snapshots[wk]) return snapshots[wk];
  const files = Object.keys(snapshots);
  // 1) 全路径相等（只是前缀 / 编码不同）
  const exact = files.filter((f) => normWorkflowKey(f) === normWorkflowKey(wk));
  if (exact.length) return snapshots[exact[0]];
  // 2) 只有文件名可比：必须唯一，否则宁可不恢复，也不赌
  const loose = files.filter((f) => sameWorkflow(f, wk));
  if (loose.length === 1) return snapshots[loose[0]];
  if (loose.length > 1) {
    warn("存在多个同名工作流快照，已跳过以免串文件:", loose.join(" | "));
    return null;
  }
  return null;
}

/** 最近保存的、但不属于当前工作流的快照：只用于提示，绝不用于恢复。 */
function otherLatestSnapshot() {
  const wk = currentWorkflowKey();
  const list = Object.keys(snapshots)
    .map((f) => snapshots[f])
    .filter((s) => s && !sameWorkflow(s.file || "", wk))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return list[0] || null;
}

/** 从服务端读取当前工作流的模板（服务端是权威来源，跨浏览器共享）。 */
let _presetLoadedKey = null;
async function loadPresetsFromServer() {
  const wf = currentWorkflowKey();
  _presetLoadedKey = wf; // 先记下，避免每次 watchdog 都重复拉
  try {
    presets = await apiGetPresets(wf);
    log("已从服务端加载参数模板:", wf, "|", Object.keys(presets).length, "个");
    return true;
  } catch (e) {
    warn("读取参数模板失败:", e.message || e);
    return false;
  }
}

/** 哪些 widget 可以进模板：普通参数值，排除图像/上传/按钮类。 */
function isPresetWidget(w) {
  if (!w || w.serialize === false || !w.name) return false;
  const t = String(w.type || "").toLowerCase();
  if (["image", "imagecombo", "upload", "file", "button"].includes(t)) return false;
  if (/^(image|image_upload|upload|video|audio|gif|file)$/i.test(String(w.name))) return false;
  return true;
}

/**
 * 设置节点旁通 / 忽略（静音）状态：0=正常 2=忽略 4=旁通。
 * 用 LiteGraph 官方 changeMode()（核心 groupOptions.ts 也是这个路子），
 * 再 graph.change() 让画布重绘、节点变灰/变紫。
 */
function setNodeModeSafe(node, mode) {
  if (!node) return false;
  const m = Number(mode) || 0;
  let ok = false;
  try {
    if (typeof node.changeMode === "function") ok = node.changeMode(m) !== false;
  } catch { /* 忽略 */ }
  if (!ok) node.mode = m; // changeMode 不认的值直接写，兜底
  try { node.graph?.change?.(); } catch { /* 忽略 */ }
  try { node.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  return true;
}

/** 把当前画布所有节点的普通 widget 值 + 旁通/忽略状态抓成命名模板，写服务端。 */
async function savePreset(name) {
  name = String(name || "").trim();
  if (!name) { flashNotice("请输入模板名", false); return; }
  const nodes = Array.isArray(app.graph?.nodes) ? app.graph.nodes.slice() : [];
  const ids = nodeIdentity(nodes);
  const values = [];
  const modes = [];
  for (const n of nodes) {
    const key = ids.get(n.id);
    if (!key) continue;
    // 旁通(4) / 忽略(2) / 正常(0) 全部记下来，套用模板时连状态一起还原
    modes.push({ type: String(n.type || ""), identity: key, mode: Number(n.mode) || 0 });
    for (const w of (Array.isArray(n.widgets) ? n.widgets : [])) {
      if (!isPresetWidget(w)) continue;
      let v;
      try { v = clone(w.value); } catch { continue; }
      if (v === undefined || v === null) continue;
      try { if (JSON.stringify(v).length > 20000) continue; } catch { continue; }
      values.push({ type: String(n.type || ""), identity: key, widget: w.name, value: v });
    }
  }
  if (!values.length && !modes.length) { flashNotice("画布上没有可保存的参数", false); return; }
  const workflow = currentWorkflowKey();
  try {
    await apiEditPreset("save", name, { savedAt: Date.now(), values, modes }, workflow);
  } catch (e) {
    warn("保存参数模板失败:", e.message || e);
    flashNotice("保存失败", false);
    return;
  }
  await render();
  flashNotice("✓ 模板已保存", true);
  const moded = modes.filter((m) => m.mode).length;
  log("已保存参数模板:", name, "| 工作流:", workflow, "| 参数项:", values.length,
      "| 旁通/忽略节点:", moded);
}

/** 套用模板：按「类型 + 同类型序号 + widget 名」填值，只改参数，不碰后端/缩放/图像。 */
async function applyPreset(name) {
  try { await loadPresetsFromServer(); } catch { /* 用内存里的 */ }
  const p = presets[name];
  if (!p) { flashNotice("模板不存在", false); return; }
  const nodes = Array.isArray(app.graph?.nodes) ? app.graph.nodes.slice() : [];
  const ids = nodeIdentity(nodes);
  const byIdentity = new Map();
  for (const n of nodes) {
    const k = ids.get(n.id);
    if (k && !byIdentity.has(k)) byIdentity.set(k, n);
  }
  let applied = 0;
  const skipped = [];
  for (const item of (p.values || [])) {
    const node = byIdentity.get(item.identity);
    if (!node) { skipped.push(String(item.type || "?") + "#" + item.identity + "(无此节点)"); continue; }
    if (String(node.type) !== String(item.type)) { skipped.push(item.widget + "(类型不符)"); continue; }
    const w = (Array.isArray(node.widgets) ? node.widgets : []).find((x) => x?.name === item.widget);
    if (!w || w.serialize === false) { skipped.push(item.widget + "(无此参数)"); continue; }
    try {
      notifyWidgetChange(node, w, clone(item.value));
      applied++;
    } catch (e) {
      skipped.push(item.widget + "(写入失败)");
    }
  }

  // 旁通 / 忽略状态（mode）：模板保存时节点是旁通(4)还是忽略(2)，
  // 套用时一起还原；模板里是正常(0)的节点也会被恢复成正常，
  // 不会因为模板套用后仍留着当前画布上的旁通状态。
  let modeApplied = 0;
  const modeSkipped = [];
  for (const item of (Array.isArray(p.modes) ? p.modes : [])) {
    const node = byIdentity.get(item.identity);
    if (!node) { modeSkipped.push(String(item.type || "?") + "#" + item.identity + "(无此节点)"); continue; }
    if (String(node.type) !== String(item.type)) { modeSkipped.push(String(item.type) + "(类型不符)"); continue; }
    try {
      setNodeModeSafe(node, item.mode);
      modeApplied++;
    } catch (e) {
      modeSkipped.push(String(item.type) + "(写入失败)");
    }
  }

  try { app.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  flashNotice("✓ 模板已套用", true);
  log("已套用参数模板:", name, "| 填入:", applied, "| 状态:", modeApplied,
      "| 跳过:", skipped.length + modeSkipped.length);
  const moded = (Array.isArray(p.modes) ? p.modes : []).filter((m) => Number(m.mode));
  showResultPanel("✓ 参数模板已套用", [
    "模板: " + name,
    "填入参数: " + applied + " 项",
    "还原旁通/忽略: " + modeApplied + " 个节点" + (moded.length
      ? "（模板里 " + moded.length + " 个非正常状态）" : ""),
    "跳过: " + (skipped.length + modeSkipped.length) + " 项" + (skipped.length
      ? "（" + skipped.slice(0, 6).join("、") + "）" : ""),
    p.modes ? "" : "⚠ 这个模板是旧版本保存的，没记录旁通/忽略状态",
    "保存时间: " + (p.savedAt ? new Date(p.savedAt).toLocaleString() : "-"),
    "只改节点参数与旁通状态，不动后端 / 缩放 / 图像",
  ].filter((s) => s !== ""), true);
}

async function deletePreset(name) {
  if (!name) return;
  try {
    await apiEditPreset("delete", name, null, currentWorkflowKey());
    await render();
    flashNotice("✓ 模板已删除", true);
    log("已删除参数模板:", name);
  } catch (e) {
    warn("删除参数模板失败:", e.message || e);
    flashNotice("删除失败", false);
  }
}

/** 模板命名 / 删除的小弹窗（不依赖浏览器原生 prompt）。 */
let presetDialog = null;
function openPresetDialog(kind) {
  if (presetDialog) presetDialog.remove();
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "100000",
    background: "rgba(0,0,0,.45)", display: "flex",
    alignItems: "center", justifyContent: "center",
  });
  const box = document.createElement("div");
  Object.assign(box.style, {
    minWidth: "300px", maxWidth: "460px", padding: "18px 20px",
    background: "var(--color-background-primary, #1e1e1e)",
    color: "var(--color-text-primary, #ddd)",
    border: "1px solid var(--p-primary-color, #4dabf7)",
    borderRadius: "10px", font: "13px/1.6 var(--font-sans, sans-serif)",
    boxShadow: "0 8px 32px rgba(0,0,0,.5)",
  });
  const title = document.createElement("div");
  title.textContent = kind === "save" ? "保存当前参数为模板" : "删除参数模板";
  Object.assign(title.style, { fontWeight: "600", fontSize: "15px", marginBottom: "6px" });
  const hint = document.createElement("div");
  hint.textContent = kind === "save"
    ? "保存当前画布普通参数（不含图像文件）+ 各节点的旁通/忽略状态，只属于当前工作流；之后可从菜单一键填回。"
    : "选择要删除的模板（仅当前工作流）：";
  hint.style.opacity = ".75";
  hint.style.marginBottom = "12px";

  let field;
  if (kind === "save") {
    field = document.createElement("input");
    field.type = "text";
    field.placeholder = "例如：Qwen 出图参数";
    Object.assign(field.style, {
      width: "100%", boxSizing: "border-box", padding: "7px 9px",
      background: "var(--color-background-secondary, #2a2a2a)",
      color: "inherit", border: "1px solid var(--p-primary-color, #4dabf7)",
      borderRadius: "5px", outline: "none",
    });
  } else {
    field = document.createElement("select");
    const names = Object.keys(presets).sort();
    if (!names.length) {
      const o = document.createElement("option");
      o.textContent = "（暂无模板）";
      field.appendChild(o);
      field.disabled = true;
    }
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n + "（" + (presets[n].values?.length || 0) + " 项）";
      field.appendChild(o);
    }
    Object.assign(field.style, {
      width: "100%", boxSizing: "border-box", padding: "7px 9px",
      background: "var(--color-background-secondary, #2a2a2a)",
      color: "inherit", border: "1px solid var(--p-primary-color, #4dabf7)",
      borderRadius: "5px", outline: "none",
    });
  }

  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "16px" });
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  const ok = document.createElement("button");
  ok.textContent = kind === "save" ? "保存" : "删除";
  for (const b of [cancel, ok]) {
    Object.assign(b.style, {
      padding: "6px 14px", borderRadius: "5px", cursor: "pointer",
      border: "1px solid var(--p-primary-color, #4dabf7)",
      background: "var(--color-background-secondary, #2a2a2a)", color: "inherit",
    });
  }
  const close = () => { if (overlay.parentNode) overlay.remove(); presetDialog = null; };
  cancel.onclick = close;
  ok.onclick = async () => {
    const name = String(field.value || "").trim();
    close();
    if (kind === "save") await savePreset(name);
    else await deletePreset(name);
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !field.disabled) ok.click();
    if (e.key === "Escape") close();
  });
  overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  row.append(cancel, ok);
  box.append(title, hint, field, row);
  overlay.appendChild(box);
  (document.body || document.documentElement).appendChild(overlay);
  presetDialog = overlay;
  try { field.focus(); } catch { /* 忽略 */ }
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

/**
 * 顶栏缩放滑块（可拖动连续调节，取代原来的五档菜单项）。
 * 放在 SplitButton 的 popup 里作为自定义 HTMLElement。
 * 两个关键点：
 *  1. popup 挂到 document.body（见 render() 的 position:"absolute"），不继承顶栏 zoom。
 *     否则拖动时顶栏一缩，滑块跟着缩小+位移，会从鼠标底下跑掉。
 *  2. 拖动中只调 setZoom(z, true) 就地应用 CSS + 更新读数，不 render——
 *     否则 popup DOM 被重建、正在拖的 input 被销毁，拖不动。松手也只记日志不重建。
 */
function buildZoomSlider() {
  const row = document.createElement("div");
  row.className = "accel-switch-zoom-slider";
  row.title = "拖动调节整个顶栏大小（含队列/任务浮层）；松手后保存";

  const label = document.createElement("span");
  label.className = "accel-switch-zoom-label";
  label.textContent = "顶栏缩放";

  const range = document.createElement("input");
  range.type = "range";
  range.id = "accel-switch-zoom-range";
  range.min = String(Math.round(ZOOM_MIN * 100));
  range.max = String(Math.round(ZOOM_MAX * 100));
  range.step = String(Math.round(ZOOM_STEP * 100));
  range.value = String(Math.round(zoomValue * 100));

  const val = document.createElement("span");
  val.className = "accel-switch-zoom-value";
  val.id = "accel-switch-zoom-value";
  val.textContent = Math.round(zoomValue * 100) + "%";

  // input 事件：拖动中实时应用（live=true，只改 CSS/读数，不重建 DOM）。
  // 注意不要再按 dragging 过滤——之前那段判断导致拖第二次起完全不生效。
  range.addEventListener("input", () => setZoom(Number(range.value) / 100, true));

  // range 原生拖动本身就能跟随指针；popup 已在 body 不随顶栏缩放，无需自定义 pointer 映射。
  // 加 pointer capture 只是兜底：即使滑块因任何原因位移，pointermove 仍持续送到本元素。
  let dragging = false;
  let activePointer = null;
  range.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging = true;
    activePointer = e.pointerId;
    try { range.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  });
  const endDrag = (e) => {
    if (!dragging) return;
    if (e && e.pointerId != null && activePointer != null && e.pointerId !== activePointer) return;
    dragging = false;
    if (activePointer != null) {
      try { range.releasePointerCapture(activePointer); } catch { /* 忽略 */ }
      activePointer = null;
    }
  };

  // change/pointerup：松手后只落日志，不 render（render 会销毁 popup/滑块）。
  // 用「值是否变化」去重，不要用一次性 committed 标志——那会让滑块只能生效一次，
  // 表现为拖到 95% 后再也拖不动、100% 也回不去。
  let lastCommitted = String(Math.round(zoomValue * 100));
  const commit = () => {
    endDrag();
    if (range.value === lastCommitted) return;
    lastCommitted = range.value;
    setZoom(Number(range.value) / 100, true); // 保存 + 应用 + 同步读数
    log("顶栏缩放:", Math.round(zoomValue * 100) + "%");
  };
  range.addEventListener("change", commit);
  range.addEventListener("pointerup", commit);
  range.addEventListener("touchend", commit);
  range.addEventListener("pointercancel", endDrag);
  // 阻止冒泡：即使 ComfyPopup 的全局捕获点击处理在别处也不误关菜单
  for (const ev of ["pointerdown", "mousedown", "click", "input", "change"]) {
    range.addEventListener(ev, (e) => e.stopPropagation());
  }

  row.append(label, range, val);
  return row;
}

async function render() {
  const { ComfyButton, ComfySplitButton } = await getComponents();
  const cur = state.current;
  // 菜单/按钮一律反映「当前工作流自己」的快照，不用全局最近保存的那份——
  // 否则切到没保存过的 B 工作流时，按钮还在说"可恢复 A 的设置"，一点就串了。
  const ownSnap = snapshotForCurrentWorkflow();
  const curLabel = state.available[cur]?.label || state.all?.[cur]?.label || cur;
  const curShort = state.available[cur]?.short || state.all?.[cur]?.short || cur;
  badgeText = curShort;
  primaryBtn = new ComfyButton({
    icon: "undo", // ↺ 恢复图标（原为 bolt=循环切换后端）
    content: curShort,
    tooltip: `恢复当前工作流保存时的样子（节点参数 + 连线/位置，不改加速后端、不改顶栏缩放；只认本工作流的快照；`
           + `当前后端：${curLabel}；▾ 选后端，Ctrl+Alt+R 恢复，Ctrl+Alt+A 切换后端）`,
    action: () => restoreSnapshot(),
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
    content: (ownSnap ? "↺  " : "    ") + "恢复上次保存的样子",
    tooltip: ownSnap
      ? `把画布还原成保存那一刻：${ownSnap.nodes?.length || 0} 个节点的参数/旁通/图像，`
        + "连线（保存时没接的线也断回去）、节点位置与大小一起还原；不改顶栏缩放"
      : "当前工作流还没有快照：先 Ctrl+S 保存一次。恢复只认本工作流的快照，不会套用别的工作流",
    classList: "accel-switch-item accel-switch-restore-item" + (ownSnap ? " accel-switch-active" : ""),
    action: () => restoreSnapshot(),
  }).element);

  // 上一个任务：把服务端上「那次真正执行的任务」原样再入队 / 复制其参数
  const jobSep = document.createElement("div");
  jobSep.className = "accel-switch-sep";
  items.push(jobSep);
  const jobHint = lastJob?.prompt ? " · " + jobAgo(lastJob) : " · 无记录";
  items.push(new ComfyButton({
    content: "     ↻ 重跑上一个任务（同参数）" + jobHint,
    tooltip: "把最近一次提交的任务原样再入队（不分工作流）：节点参数、种子都不变，结果应与上次一致。"
           + "适合输出文件丢了，或换个加速后端重跑对比真实采样耗时。Ctrl+Alt+P",
    classList: "accel-switch-item accel-switch-job-item",
    action: () => rerunLast(false),
  }).element);
  items.push(new ComfyButton({
    content: "     🎲 重跑上一个任务（换随机种子）",
    tooltip: "同上，但把所有 seed / noise_seed 换成新的随机值——不用改画布直接「再来一张」。"
           + "Ctrl+Alt+Shift+P",
    classList: "accel-switch-item accel-switch-job-item",
    action: () => rerunLast(true),
  }).element);
  const ownJob = jobForCurrentWorkflow();
  items.push(new ComfyButton({
    content: "     ⇩ 把本工作流上一个任务的参数填回画布"
      + (ownJob ? " · " + jobAgo(ownJob) : " · 本工作流无记录"),
    tooltip: "只取「当前工作流自己」上一次运行的任务（A 的不会串到 B），"
           + "按「节点 id + 类型」双重校验写回参数"
           + "（只改参数，不动连线、不改加速后端/顶栏缩放）",
    classList: "accel-switch-item accel-switch-job-item",
    action: () => applyLastJobToCanvas(),
  }).element);
  items.push(new ComfyButton({
    content: "     ⧉ 复制上一个任务参数",
    tooltip: "把上一个任务的 API 格式参数（JSON）复制到剪贴板，同时打印到 F12 console，方便存档/分享",
    classList: "accel-switch-item accel-switch-job-item",
    action: () => copyLastParams(),
  }).element);

  // 常用参数模板：一个模板一个菜单项，点一下把保存时的参数和旁通状态填回当前画布
  const presetSep = document.createElement("div");
  presetSep.className = "accel-switch-sep";
  items.push(presetSep);
  const presetNames = Object.keys(presets).sort((a, b) =>
    (presets[b]?.savedAt || 0) - (presets[a]?.savedAt || 0));
  for (const name of presetNames) {
    const hasModes = Array.isArray(presets[name]?.modes);
    items.push(new ComfyButton({
      content: "     ★ " + name,
      tooltip: `套用本工作流的参数模板「${name}」：按类型+序号+参数名填值`
        + (hasModes ? "，并还原各节点的旁通/忽略状态" : "（旧模板，无旁通状态）")
        + "，不改后端/缩放/图像",
      classList: "accel-switch-item accel-switch-preset-item",
      action: () => applyPreset(name),
    }).element);
  }
  items.push(new ComfyButton({
    content: "     ＋ 保存当前参数为模板…",
    tooltip: "把当前画布普通参数 + 各节点旁通/忽略状态存成命名模板，仅属于当前工作流（不含图像文件）",
    classList: "accel-switch-item",
    action: () => openPresetDialog("save"),
  }).element);
  items.push(new ComfyButton({
    content: "     ✕ 删除参数模板…",
    tooltip: "删除一个属于当前工作流的参数模板",
    classList: "accel-switch-item",
    action: () => openPresetDialog("delete"),
  }).element);

  const sep = document.createElement("div");
  sep.className = "accel-switch-sep";
  items.push(sep);
  items.push(buildZoomSlider());
  const old = split?.element;
  const oldPopup = split?.popup?.element;
  // 先正常关闭旧弹层，走到 ComfyPopup._hide() 解绑 resize/click/keydown 监听，再删 DOM
  if (split?.popup?.open) split.popup.open = false;
  // position:"absolute" → ComfyPopup.container = document.body，菜单弹层不继承顶栏 CSS zoom。
  // 这是缩放滑块能稳定拖动的关键：顶栏缩放时弹层/滑块不会被一起缩小、位移。
  split = new ComfySplitButton(
    { primary: primaryBtn, mode: "click", position: "absolute" },
    ...items
  );
  split.popup.element.classList.add("accel-switch-popup");
  split.element.id = "accel-switch-split";
  if (old && old.parentElement) {
    old.parentElement.replaceChild(split.element, old);
  } else {
    insert();
  }
  // body 里的旧弹层不会随 split.element 一起被替换，需显式清理，避免每次 render 残留一个。
  if (oldPopup?.parentElement) oldPopup.remove();
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
  let noneTick = 0;
  watchdog = setInterval(() => {
    const zr = zoomRoot();
    if (zr && zr.style.zoom !== String(zoomValue)) applyZoom();
    // 每 5 个 tick（约 10s）兜一次「无」选项：前端「刷新节点定义」会把
    // widget.options.values 整个换成新数组，我们的「无」会被冲掉。
    if (++noneTick % 5 === 0) patchAllNodeWidgets();
    // 切换工作流后，模板列表要跟着换成该工作流自己的
    const wk = currentWorkflowKey();
    if (wk !== _presetLoadedKey) {
      log("工作流已切换，重新加载该工作流的参数模板:", wk);
      loadPresetsFromServer().then(() => render()).catch(() => {});
    }
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
    // 弹层挂在 body，用 fixed 对齐 getBoundingClientRect 的视口坐标；且不受顶栏 zoom 影响
    "body > .comfyui-popup.accel-switch-popup{position:fixed}",
    ".accel-switch-sep{height:1px;margin:4px 6px;background:currentColor;opacity:.25;flex:none}",
    ".accel-switch-zoom-slider{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:.9em;white-space:nowrap;cursor:default}",
    ".accel-switch-zoom-label{opacity:.85;flex:none}",
    ".accel-switch-zoom-slider input[type=range]{flex:1;min-width:110px;max-width:160px;accent-color:var(--p-primary-color,#4dabf7);cursor:ew-resize}",
    ".accel-switch-zoom-value{min-width:38px;text-align:right;font-variant-numeric:tabular-nums;opacity:.9;flex:none}",
    ".accel-switch-restore-item{font-weight:600}",
    ".accel-switch-unavailable{opacity:.4;cursor:not-allowed}",
    ".accel-switch-bench-item{font-weight:600}",
    ".accel-switch-job-item{font-weight:600}",
  ].join("\n");
  (document.head || document.documentElement).appendChild(st);
}

// ---------------------------------------------------------------- 快捷键

function setupHotkeys() {
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.altKey) || e.metaKey) return;
    const target = e.target;
    if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
        || target.isContentEditable)) return;
    if (e.code === "KeyP") {
      // Ctrl+Alt+P 重跑（同参数），Ctrl+Alt+Shift+P 重跑（换随机种子）
      e.preventDefault();
      log("快捷键 Ctrl+Alt+P：重跑上一个任务", e.shiftKey ? "(换种子)" : "(同参数)");
      rerunLast(!!e.shiftKey);
      return;
    }
    if (e.shiftKey) return;
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

  /**
   * 节点定义注册时给「加载图像 / 视频 / 音频」的 combo 加「无」选项。
   * 放在这里（而不是 setup）是因为它必须赶在 LiteGraph 用 nodeDef 建 widget 之前。
   */
  beforeRegisterNodeDef(nodeType, nodeData) {
    try {
      patchNodeDefCombo(nodeData);
    } catch (e) {
      warn("补「无」选项失败:", nodeData?.name, e.message || e);
    }
  },

  /** 节点实例建好后，把「无」补到实际 widget 上（加载已有工作流时也走这里）。 */
  nodeCreated(node) {
    try {
      patchNodeComboWidgets(node);
    } catch (e) {
      warn("节点实例补「无」失败:", e.message || e);
    }
  },

  async setup() {
    loadZoom();
    loadSnapshotCache();
    hookWorkflowSave();
    setupHotkeys();
    injectStyles();
    // 存量节点也补一次「无」（扩展可能晚于节点加载，如手动刷新节点定义后）
    setTimeout(() => patchAllNodeWidgets(), 300);
    setTimeout(() => patchAllNodeWidgets(), 1500);
    // Vue app / Pinia store 比扩展 setup 更晚挂载，延迟预热抓取 nodeOutputStore
    setTimeout(() => getNodeOutputStore(), 800);
    setTimeout(() => getNodeOutputStore(), 2500);
    // 服务端快照为权威来源，异步拉；拉到后重绘菜单（让「↺」项显示）
    loadSnapshotsFromServer().then(() => render()).catch(() => {});
    // 参数模板也从服务端拉，拉到后重绘菜单（让 ★ 模板项显示）
    loadPresetsFromServer().then(() => render()).catch(() => {});
    // 刷新过页面时内存里没有运行记录，从 /history 补一份，让「重跑」项显示时间
    getLastJob().then(() => render()).catch(() => {});
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
