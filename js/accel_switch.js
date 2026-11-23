/**
 * ComfyUI-AccelSwitch — 顶栏一键切换全局注意力加速后端 + 顶栏缩放
 *
 * 位置：顶部命令栏（与“管理器 / 翻译开关”同一行），优先贴在运行按钮组左侧。
 * 形态：与“运行 ▾”同款 SplitButton——点主体循环切换，点箭头弹出完整列表。
 *       主体为纯图标（闪电），当前后端名在悬停提示里；下拉列表可选完整后端。
 * 顶栏缩放：下拉菜单里有 100%~60% 五档，对整个顶栏整列（命令栏卡片 + 队列/
 *       任务浮层）做 CSS zoom 等比缩小，选择记 localStorage，刷新不丢。
 * 数据：GET/POST ./accel_switch（见 custom_nodes/ComfyUI-AccelSwitch/__init__.py）。
 */

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const API = "./accel_switch";
const LOG_TAG = "[AccelSwitch]";
const log = (...a) => console.log(LOG_TAG, ...a);
const warn = (...a) => console.warn(LOG_TAG, ...a);

/** @type {{current:string, available:Object<string,{label:string,short:string,desc:string}>}} */
let state = { current: "auto", available: {} };
let split = null;          // 当前 ComfySplitButton 实例
let primaryBtn = null;     // 主体按钮（纯图标；content 仅用于错误闪烁）
let inserted = false;      // 是否已插入命令栏
let watchdog = null;
let lastSnapshot = null;   // 上次保存工作流时的设置快照
let fetchHooked = false;   // api.fetchApi 是否已挂钩

// ---------------------------------------------------------------- 顶栏缩放

const ZOOM_KEY = "Comfy.AccelSwitch.TopbarZoom";
const ZOOM_LEVELS = [1, 0.9, 0.8, 0.7, 0.6];
let zoomValue = 0.8;       // 默认紧凑（用户反馈顶栏占地方）

function loadZoom() {
  try {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (ZOOM_LEVELS.includes(v)) zoomValue = v;
  } catch {
    /* localStorage 不可用时保持默认 */
  }
}

function saveZoom() {
  try {
    localStorage.setItem(ZOOM_KEY, String(zoomValue));
  } catch {
    /* 忽略 */
  }
}

/**
 * 顶栏"右列"：包含命令栏卡片（top-menu-actionbars）与队列/任务浮层的整列。
 * 它是内容宽度（非拉伸），zoom 它不会在全宽顶栏上留下右侧空缺；
 * 面包屑列在左侧不受影响（主画布下为空）。
 */
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

// ---------------------------------------------------------------- 工作流设置快照

const SNAP_KEY = "Comfy.AccelSwitch.LastWorkflowSnapshot";

function loadSnapshot() {
  try {
    lastSnapshot = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
  } catch {
    lastSnapshot = null;
  }
}

function storeSnapshot(snap) {
  lastSnapshot = snap;
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch (e) {
    warn("保存设置快照失败（localStorage）:", e.message || e);
  }
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 工作流保存到 userdata 的那一刻，记录后端 / 缩放 / 所有节点参数。 */
function captureSnapshot(file, workflow) {
  const nodes = (workflow?.nodes || []).map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title ?? null,
    mode: n.mode ?? 0,
    widgets_values: clone(n.widgets_values) ?? null,
    flags: clone(n.flags) ?? null,
  }));
  const snap = {
    file,
    savedAt: Date.now(),
    backend: state.current,
    zoom: zoomValue,
    nodes,
  };
  storeSnapshot(snap);
  log("已记录工作流保存时的设置:", file,
      "| 后端:", state.current,
      "| 缩放:", Math.round(zoomValue * 100) + "%",
      "| 节点:", nodes.length);
}

/**
 * 拦截 api.fetchApi：ComfyUI 保存工作流走 POST /userdata/workflows/xxx.json。
 * 保存成功后再抓快照，这样不只是节点参数，连后端/缩放也是「保存那一刻」的值。
 */
function hookWorkflowSave() {
  if (fetchHooked || !api || typeof api.fetchApi !== "function") return;
  const original = api.fetchApi.bind(api);
  api.fetchApi = async function (route, init) {
    const response = await original(route, init);
    try {
      const url = String(route || "");
      if ((init?.method || "GET").toUpperCase() !== "POST" || !url.startsWith("/userdata/")) {
        return response;
      }
      if (!response || response.ok === false) return response;
      const clean = url.split("?")[0];
      const file = decodeURIComponent(clean.slice("/userdata/".length));
      if (!file.startsWith("workflows/") || !file.endsWith(".json") || file.endsWith(".index.json")) {
        return response;
      }
      let workflow = null;
      try {
        workflow = JSON.parse(init.body);
      } catch {
        /* body 不是 JSON（例如字符串）就跳过节点参数 */
      }
      if (workflow && Array.isArray(workflow.nodes)) captureSnapshot(file, workflow);
    } catch (e) {
      warn("记录工作流快照失败:", e.message || e);
    }
    return response;
  };
  fetchHooked = true;
}

/** 一键恢复：后端 + 顶栏缩放 + 每个节点的参数（widget 值 / 旁通状态 / 标题）。 */
async function restoreSnapshot() {
  const snap = lastSnapshot;
  if (!snap) {
    warn("还没有快照：请先保存一次工作流");
    flashNotice("无快照", false);
    return;
  }
  let matched = 0;
  try {
    const graph = app.graph;
    for (const item of snap.nodes || []) {
      const node = graph?.getNodeById?.(item.id);
      if (!node) continue;
      if (Array.isArray(item.widgets_values)) {
        const values = clone(item.widgets_values);
        node.widgets_values = values;
        (node.widgets || []).forEach((widget, i) => {
          if (i >= values.length) return;
          try {
            widget.value = values[i];
          } catch {
            /* 某些自定义 widget 不接受直接赋值，widgets_values 仍已写入 */
          }
        });
      }
      if (item.mode !== undefined && item.mode !== null) node.mode = item.mode;
      if (item.title !== undefined && item.title !== null) node.title = item.title;
      if (item.flags) {
        try {
          node.flags = clone(item.flags);
        } catch {
          /* 忽略 */
        }
      }
      matched++;
    }
    graph?.setDirtyCanvas?.(true, true);
  } catch (e) {
    warn("恢复节点设置失败:", e.message || e);
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
  log("已恢复保存时的设置:", snap.file, "| 节点:", matched);
  flashNotice("✓ 已恢复", true);
}

// ---------------------------------------------------------------- 组件

async function getComponents() {
  if (window.comfyAPI?.button?.ComfyButton && window.comfyAPI?.splitButton?.ComfySplitButton) {
    const { ComfyButton } = window.comfyAPI.button;
    const { ComfySplitButton } = window.comfyAPI.splitButton;
    return { ComfyButton, ComfySplitButton };
  }
  // 兜底：旧版 shim（会打一条 deprecation 警告，功能正常）
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
    if (primaryBtn) primaryBtn.content = "";
  }, 1800);
}

async function render() {
  const { ComfyButton, ComfySplitButton } = await getComponents();
  const cur = state.current;
  const curLabel = state.available[cur]?.label || cur;
  // 主体：纯图标，当前后端名放悬停提示（省地方）；错误时借 content 闪烁文字
  primaryBtn = new ComfyButton({
    icon: "bolt",
    tooltip: `全局注意力加速：${curLabel}（点击切换，▾ 选列表）`,
    action: () => choose(cycleKey()),
  });
  const items = keys().map((key) => {
    const b = state.available[key];
    const active = key === cur;
    return new ComfyButton({
      content: (active ? "✓  " : "    ") + b.label,
      tooltip: b.desc || "",
      classList: "accel-switch-item" + (active ? " accel-switch-active" : ""),
      action: () => choose(key),
    }).element;
  });
  // 一键恢复上次保存工作流时的设置（后端 + 缩放 + 节点参数）
  items.push(new ComfyButton({
    content: (lastSnapshot ? "↺  " : "    ") + "恢复上次保存的设置",
    tooltip: lastSnapshot
      ? `恢复 ${lastSnapshot.file} 保存时的加速后端 / 顶栏缩放 / ${lastSnapshot.nodes.length} 个节点参数`
      : "尚无快照：请先保存一次工作流",
    classList: "accel-switch-item accel-switch-restore-item" + (lastSnapshot ? " accel-switch-active" : ""),
    action: () => restoreSnapshot(),
  }).element);
  // 分隔线 + 顶栏缩放档位
  const sep = document.createElement("div");
  sep.className = "accel-switch-sep";
  items.push(sep);
  for (const z of ZOOM_LEVELS) {
    const active = z === zoomValue;
    items.push(new ComfyButton({
      content: (active ? "✓  " : "    ") + `顶栏缩放 ${Math.round(z * 100)}%`,
      tooltip: z === 1
        ? "恢复顶栏原始大小"
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
  // 1) 新版 Vue 命令栏（0.4x 起 .comfy-menu/menuContainer 被 display:none）：
  //    插到 settingsGroup 之前——ComfyUI-Manager 与中文翻译扩展同款策略。
  //    注意用元素自身的 before()：插入时该元素可能尚未挂到可见 DOM，
  //    Vue watchEffect 稍后会随父容器整体进入命令栏（翻译扩展实测路径）。
  const sg = app.menu?.settingsGroup?.element;
  if (sg && typeof sg.before === "function") {
    sg.before(split.element);
    if (split.element.parentElement) {
      inserted = true;
      return true;
    }
  }
  // 2) 旧版前端：仅当 .comfy-menu 与 menuContainer 均可见时才用
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
  // 3) 兜底：workflow 标签栏
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
    // 顶栏缩放：Vue 重渲染可能重建右列 → 补挂 zoom
    const zr = zoomRoot();
    if (zr && zr.style.zoom !== String(zoomValue)) applyZoom();
    if (!split) return;
    if (!split.element.isConnected) {
      // 顶栏被 Vue 重渲染冲掉 → 重新插入
      insert();
      return;
    }
    // 若本按钮排在运行按钮组之后（渲染顺序晚于它）→ 尝试搬到其左侧
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
    // 纯图标主体：左右补点 padding，看起来和旁边的图标按钮一致
    "#accel-switch-split .comfyui-split-primary .comfyui-button{padding-left:10px;padding-right:10px}",
    // 下拉里的分组分隔线
    ".accel-switch-sep{height:1px;margin:4px 6px;background:currentColor;opacity:.25;flex:none}",
    // 缩放档位字号略小，跟后端项区分
    ".accel-switch-zoom-item{font-size:.92em}",
    // 恢复项稍作强调，和后端列表区分
    ".accel-switch-restore-item{font-weight:600}",
  ].join("\n");
  (document.head || document.documentElement).appendChild(st);
}

// ---------------------------------------------------------------- 扩展入口

app.registerExtension({
  name: "ComfyUI.AccelSwitch",

  async setup() {
    loadZoom();
    loadSnapshot();
    hookWorkflowSave();
    injectStyles();
    // 顶栏锚点可能尚未就绪：轮询等待（最多 ~30s）
    let tries = 0;
    while (tries++ < 60) {
      try {
        const j = await apiGet();
        state.current = j.current || "auto";
        state.available = j.available || {};
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
        "| 顶栏缩放:", Math.round(zoomValue * 100) + "%");
  },
});
