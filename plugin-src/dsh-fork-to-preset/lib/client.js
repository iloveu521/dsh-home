window.__ModuleLoader__.load({
  id: "dsh-fork-to-preset",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    /**
     * dsh-fork-to-preset — a composer pill sitting right beside the model
     * select (seat `conversation.input.right`, immediately left of the model
     * seat in the tool row). Visual spec mirrors ui-model-selection's
     * ModelSelect trigger + menu exactly: same 28px rounded trigger, same
     * alias tokens, same upward-anchored menu card, same keyboard contract
     * (arrows move focus, Escape closes). The roster lists NAMES ONLY; the
     * detail pane pinned to the menu's bottom edge reveals the hovered/focused
     * preset's full identity (id + complete description + default badge).
     * Clicking a preset forks the current session into it (a fresh
     * independent main thread that inherits the source's completed turns).
     * Requires the patched `session.fork` (agentPreset) on both the host
     * apiproxy and client-runtime.
     */
    const NS = "dsh-fork-to-preset";
    const en = {
      label: "Fork preset",
      menuTitle: "Fork to agent preset",
      loading: "Loading presets…",
      empty: "No presets available.",
      error: "Could not load agent presets.",
      fail: "Fork failed.",
      hint: "Hover a preset to preview · click to fork",
      noDesc: "This preset has no description.",
      badgeDefault: "Default",
    };
    const zh = {
      label: "分叉预设",
      menuTitle: "分叉到 Agent 预设",
      loading: "加载 presets…",
      empty: "没有可用预设。",
      error: "无法加载 agent presets。",
      fail: "分叉失败。",
      hint: "悬停预览详情 · 点击即分叉",
      noDesc: "该预设未填写描述。",
      badgeDefault: "默认",
    };

    const STYLE_ID = "dsh-fork-to-preset-style";
    const CSS = [
      /* root — same anchor contract as ModelSelect.root */
      ".f2p-root{min-width:0;position:relative;}",
      /* trigger — byte-for-byte the model-select trigger metrics */
      ".f2p-trigger{min-width:0;max-width:200px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 6px 0 8px;font-size:13px;font-weight:500;line-height:20px;font-family:inherit;display:flex;}",
      ".f2p-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
      ".f2p-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);}",
      ".f2p-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;}",
      ".f2p-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;}",
      ".f2p-chev{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;}",
      ".f2p-chevOpen{transform:rotate(180deg);}",
      ".f2p-icon{display:inline-flex;align-items:center;flex:none;pointer-events:none;}",
      ".f2p-ok{font-weight:700;line-height:1;flex:none;}",
      ".f2p-spin{width:12px;height:12px;border-radius:50%;flex:none;",
      "border:1.5px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;",
      "animation:f2p-rot .7s linear infinite;}",
      "@keyframes f2p-rot{to{transform:rotate(360deg)}}",
      /* menu — ModelSelect.menu recipe, opens upward from composer */
      ".f2p-menu{z-index:30;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);",
      "width:min(260px,calc(100vw - 32px));max-height:min(400px,calc(100vh - 120px));box-shadow:var(--dsw-shadow-lv3);",
      "color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);",
      "border-radius:12px;padding:4px;display:flex;flex-direction:column;",
      "position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden;",
      "animation:f2p-pop .14s ease;transform-origin:100% 100%;}",
      "@keyframes f2p-pop{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}",
      ".f2p-title{color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;flex:none;}",
      ".f2p-scroll{min-height:0;overflow-y:auto;overscroll-behavior:contain;flex:1 1 auto;}",
      ".f2p-status,.f2p-empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px;}",
      /* option rows — name-only action rows (detail lives in the pane below) */
      ".f2p-opt{width:100%;min-height:32px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:none;border:none;border-radius:8px;outline:none;align-items:center;padding:4px 8px;font-size:13px;font-weight:500;line-height:20px;font-family:inherit;display:flex;}",
      ".f2p-opt:hover:not(:disabled),.f2p-opt:focus-visible{background:var(--dsw-alias-interactive-bg-hover);}",
      ".f2p-opt:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;}",
      ".f2p-opt-name{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;}",
      ".f2p-def-dot{width:6px;height:6px;border-radius:50%;flex:none;margin-left:auto;background:var(--dsw-alias-state-success-primary,currentColor);opacity:.75;}",
      /* detail pane — hover/focus reveal, pinned to the menu's bottom edge */
      ".f2p-detail{flex:none;max-height:132px;overflow-y:auto;margin:2px -4px -4px;padding:7px 10px 8px;border-radius:0 0 12px 12px;",
      "background:color-mix(in srgb,var(--dsw-specific-menu) 92%,currentColor 8%);",
      "border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);}",
      ".f2p-detail-name{color:var(--dsw-alias-label-primary);align-items:center;gap:6px;font-size:12px;font-weight:600;line-height:18px;display:flex;}",
      ".f2p-detail-id{color:var(--dsw-alias-label-caption);flex:none;font-size:11px;font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}",
      ".f2p-badge{color:var(--dsw-alias-label-caption);background:var(--dsw-alias-interactive-bg-hover);border-radius:4px;flex:none;padding:0 4px;font-size:10px;font-weight:500;line-height:16px;}",
      ".f2p-detail-desc{color:var(--dsw-alias-label-secondary);margin-top:3px;font-size:12px;line-height:18px;white-space:normal;word-break:break-word;}",
      ".f2p-hint{color:var(--dsw-alias-label-tertiary);padding:2px 0;font-size:12px;line-height:18px;}",
      /* transient fork error popover above the pill */
      ".f2p-err{position:absolute;bottom:calc(100% + 6px);right:0;z-index:31;",
      "max-width:min(320px,70vw);padding:7px 9px;border-radius:8px;",
      "font-size:12px;line-height:18px;text-align:left;pointer-events:none;",
      "color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);",
      "animation:f2p-in .16s ease;white-space:normal;word-break:break-word;}",
      "@keyframes f2p-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}",
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (!document.getElementById(STYLE_ID)) {
        const st = document.createElement("style");
        st.id = STYLE_ID;
        st.textContent = CSS;
        document.head.appendChild(st);
      }
    }

    const BRANCH_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7"/><circle cx="4" cy="12.5" r="1.7"/><circle cx="12" cy="3.5" r="1.7"/><path d="M4 5.2v5.6M12 5.2v1.2c0 1.6-1.3 2.7-2.9 2.7H5.9"/></svg>';
    const CHEVRON_SVG = '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 5.5 7 9l3.5-3.5"/></svg>';

    function SvgWrap({ html, className }) {
      return react_jsx_runtime.jsx("span", {
        className: className || "f2p-icon",
        dangerouslySetInnerHTML: { __html: html },
      });
    }

    function ForkToPresetAction({ sessionId, listPresets, toPreset, t }) {
      const [presets, setPresets] = react.useState(null); // null = loading, array = loaded
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [done, setDone] = react.useState(false);
      const [err, setErr] = react.useState(null);
      const [preview, setPreview] = react.useState(null); // hovered/focused preset
      const rootRef = react.useRef(null);
      const errTimer = react.useRef(null);

      const showError = react.useCallback((msg) => {
        setErr(msg);
        if (errTimer.current) clearTimeout(errTimer.current);
        errTimer.current = setTimeout(() => setErr(null), 6000);
      }, []);

      react.useEffect(() => () => {
        if (errTimer.current) clearTimeout(errTimer.current);
      }, []);

      const load = react.useCallback(() => {
        setPresets(null);
        return listPresets().then((list) => {
          setPresets(list || []);
        }).catch((e) => {
          setPresets([]);
          showError(String((e && e.message) ? e.message : e) || t("error"));
        });
      }, [listPresets, showError, t]);
      react.useEffect(() => { load(); }, [load]);

      // Outside click + Escape close, mirroring the model select's menu.
      react.useEffect(() => {
        if (!open) return undefined;
        const closeOutside = (event) => {
          if (!rootRef.current || !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", closeOutside);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", closeOutside);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      // Roving focus over option rows (ModelSelect's moveFocus contract),
      // resolved against LIVE DOM order — never a stale registration array.
      const moveFocus = (offset) => {
        const items = Array.from(rootRef.current?.querySelectorAll(".f2p-opt:not(:disabled)") || []);
        if (items.length === 0) return;
        const active = items.indexOf(document.activeElement);
        const next = active === -1
          ? (offset > 0 ? 0 : items.length - 1)
          : (active + offset + items.length) % items.length;
        items[next]?.focus();
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          return;
        }
        if (!open) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(event.key === "ArrowDown" ? 1 : -1);
        }
      };

      const runFork = (presetId) => {
        if (!presetId || busy || !sessionId) return;
        setOpen(false);
        setPreview(null);
        setBusy(true);
        setErr(null);
        toPreset(sessionId, presetId).then((ok) => {
          setBusy(false);
          if (ok) {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          } else {
            showError(t("fail"));
          }
        }).catch((e) => {
          setBusy(false);
          showError(String((e && e.message) ? e.message : e));
        });
      };

      const list = presets || [];
      return react_jsx_runtime.jsxs("div", {
        ref: rootRef,
        className: "f2p-root",
        onKeyDown,
        children: [
          react_jsx_runtime.jsxs("button", {
            type: "button",
            className: "f2p-trigger",
            "aria-label": t("label"),
            "aria-haspopup": "menu",
            "aria-expanded": open,
            title: t("menuTitle"),
            disabled: busy,
            onClick: () => {
              if (open) setOpen(false);
              else { load(); setOpen(true); }
            },
            children: [
              busy
                ? react_jsx_runtime.jsx("span", { className: "f2p-spin", "aria-hidden": true })
                : done
                  ? react_jsx_runtime.jsx("span", { className: "f2p-ok", "aria-hidden": true, children: "\u2713" })
                  : react_jsx_runtime.jsx(SvgWrap, { html: BRANCH_SVG }),
              react_jsx_runtime.jsx("span", { className: "f2p-label", children: t("label") }),
              react_jsx_runtime.jsx(SvgWrap, { html: CHEVRON_SVG, className: open ? "f2p-chev f2p-chevOpen" : "f2p-chev" }),
            ],
          }),
          open && react_jsx_runtime.jsxs("div", {
            className: "f2p-menu",
            role: "menu",
            "aria-label": t("menuTitle"),
            "aria-busy": presets === null || busy,
            children: [
              react_jsx_runtime.jsx("div", { className: "f2p-title", children: t("menuTitle") }),
              react_jsx_runtime.jsx("div", {
                className: "f2p-scroll",
                onMouseLeave: () => setPreview(null),
                children: presets === null
                  ? react_jsx_runtime.jsx("div", { className: "f2p-status", children: t("loading") })
                  : list.length === 0
                    ? react_jsx_runtime.jsx("div", { className: "f2p-empty", children: t("empty") })
                    : list.map((p) => react_jsx_runtime.jsx("button", {
                        type: "button",
                        role: "menuitem",
                        className: "f2p-opt",
                        title: p.name || p.id,
                        disabled: busy,
                        onMouseEnter: () => setPreview(p),
                        onFocus: () => setPreview(p),
                        onClick: () => runFork(p.id),
                        children: [
                          react_jsx_runtime.jsx("span", { className: "f2p-opt-name", children: p.name || p.id }),
                          p.isDefault ? react_jsx_runtime.jsx("span", { className: "f2p-def-dot", title: t("badgeDefault"), "aria-label": t("badgeDefault") }) : null,
                        ],
                      }, p.id)),
              }),
              react_jsx_runtime.jsx("div", {
                className: "f2p-detail",
                "aria-live": "polite",
                children: preview == null
                  ? react_jsx_runtime.jsx("div", { className: "f2p-hint", children: t("hint") })
                  : react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
                      react_jsx_runtime.jsxs("div", { className: "f2p-detail-name", children: [
                        react_jsx_runtime.jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }, children: preview.name || preview.id }),
                        preview.isDefault ? react_jsx_runtime.jsx("span", { className: "f2p-badge", children: t("badgeDefault") }) : null,
                        react_jsx_runtime.jsx("span", { className: "f2p-detail-id", children: preview.id }),
                      ] }),
                      react_jsx_runtime.jsx("div", { className: "f2p-detail-desc", children: preview.description || t("noDesc") }),
                    ] }),
              }),
            ],
          }),
          err ? react_jsx_runtime.jsx("div", { className: "f2p-err", role: "alert", children: err }) : null,
        ],
      });
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "fork-to-preset: locale");
      ensureStyle();
      const sessions = ctx.sessions;
      // Session-scoped slots call `inject(sessionId)` for every mounted session.
      // The input.right owner passes an InputZone share ({session, input}); the
      // actions this component needs arrive through this inject face instead.
      const forkActions = (_sessionId) => ({
        listPresets: () => fetch("/fork-to-preset/presets", { method: "POST", headers: { "content-type": "application/json" } })
          .then((r) => r.json())
          .then((data) => (data && data.presets) || [])
          .catch(() => []),
        toPreset: async (sessionId, agentPreset) => {
          // The public client-runtime API resolves directly to the child id.
          const childId = await sessions.fork({ sessionId, agentPreset, increaseTitle: true });
          if (!childId) return false;
          sessions.open(childId);
          return true;
        },
      });
      ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
        name: "conversation.input.right",
        id: "fork-to-preset",
        locale: NS,
        inject: forkActions,
      }, ForkToPresetAction));
    }
    exports.apply = apply;
    exports.inject = ["slots", "locale", "sessions"];
    return module.exports;
  }
});
