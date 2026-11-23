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

async function apiBenchmark() {
  const r = await fetch(API + "_benchmark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
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

/** 保存工作流那一刻，抓后端 / 缩放 / 所有节点参数，写服务端 + 本地缓存。 */
function captureSnapshot(file) {
  const raw = graphNodesSerialized();
  const nodes = raw.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title ?? null,
    mode: n.mode ?? 0,
    widgets_values: clone(n.widgets_values) ?? null,
    widgets_values_named: clone(n.widgets_values_named) ?? null,
    flags: clone(n.flags) ?? null,
    properties: clone(n.properties) ?? null,
  }));
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

/**
 * 套用快照设置。withNodes=true 时用 LiteGraph 官方 node.configure() 恢复
 * 全部节点参数（含图像 widget），绕过手写 widget.value 在新版前端失效的问题。
 * 打开工作流时只套后端/缩放（节点参数本来就来自工作流文件本身）。
 */
async function applySnapshotSettings(snap, withNodes = true) {
  if (!snap) return 0;
  let matched = 0;
  if (withNodes) {
    try {
      const graph = app.graph;
      for (const item of snap.nodes || []) {
        const node = graph?.getNodeById?.(item.id);
        if (!node) continue;
        try {
          // 用节点自身的序列化作为基底，保证 inputs/outputs/连线信息完整，
          // configure 只覆盖参数字段，不会拆掉现有连线。
          const base = (typeof node.serialize === "function") ? node.serialize() : {};
          const info = {
            ...base,
            id: item.id,
            widgets_values: clone(item.widgets_values) ?? base.widgets_values,
            mode: item.mode ?? base.mode ?? 0,
            title: item.title ?? base.title,
            flags: clone(item.flags) ?? base.flags,
            properties: clone(item.properties) ?? base.properties,
          };
          if (item.widgets_values_named) info.widgets_values_named = clone(item.widgets_values_named);
          if (typeof node.configure === "function") {
            node.configure(info);
          } else {
            // 极老前端兜底
            node.widgets_values = clone(item.widgets_values);
          }
          matched++;
        } catch (e) {
          warn("恢复节点 #" + item.id + " 失败:", e.message || e);
        }
      }
      graph?.setDirtyCanvas?.(true, true);
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
  log("已套用保存时的设置:", snap.file, "| 节点:", matched);
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
async function runBenchmark() {
  flashNotice("测速中…", true);
  try {
    const j = await apiBenchmark();
    const rows = j.results || [];
    const okRows = rows.filter((r) => typeof r.ms === "number");
    const errRows = rows.filter((r) => r.error);
    const lines = okRows.length
      ? okRows.map((r, i) => (i + 1) + ". " + r.label + "  " + r.ms + " ms")
      : ["没有可用的后端完成测试"];
    for (const r of errRows) lines.push("✗ " + r.label + ": " + r.error);
    lines.push("参数: " + JSON.stringify(j.params || {}));
    lines.push("完整结果已写入 ComfyUI 日志（搜索「后端跑分」）");
    console.table(rows);
    log("后端跑分完成:", lines.join(" | "));
    flashNotice("✓ 跑分完成", true);
    showResultPanel("后端跑分（毫秒/次，越小越快）", lines, okRows.length > 0);
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
    content: "     ⚡ 后端跑分",
    tooltip: "合成注意力负载测各后端，结果弹窗显示并写入 ComfyUI 日志；不改当前选择",
    classList: "accel-switch-item accel-switch-bench-item",
    action: () => runBenchmark(),
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
