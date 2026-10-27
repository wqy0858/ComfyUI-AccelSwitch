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
let flashTimer = null;

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
  if (!primaryBtn || flashTimer) return;
  primaryBtn.content = "⚠ 失败";
  flashTimer = setTimeout(() => {
    flashTimer = null;
    if (primaryBtn) primaryBtn.content = "";
  }, 1500);
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
  ].join("\n");
  (document.head || document.documentElement).appendChild(st);
}

// ---------------------------------------------------------------- 扩展入口

app.registerExtension({
  name: "ComfyUI.AccelSwitch",

  async setup() {
    loadZoom();
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
