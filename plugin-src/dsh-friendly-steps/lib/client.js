// dsh-friendly-steps — browser half (v2, zero-interference design).
//
// Simplifies the technical process display for non-technical reading:
//   - Think blocks ([data-variant="think"]) hidden via pure CSS.
//   - Process rows (tool-call / tool-result / model-retry / compaction and
//     think-only assistant-step rows) hidden via pure CSS — React still
//     renders and owns every row, so streaming, expand/collapse and session
//     switches can never lose content (no foreign nodes are ever inserted
//     into React-managed lists; the v1 disappearance bug is structurally
//     impossible here).
//   - A floating summary pill (mounted on document.body with createRoot,
//     the same official pattern the pet plugin uses) shows
//     "✓ 已完成 N 步 · M 步未成功" / "⏳ 正在处理…（已进行 N 步）".
//     Click it to expand/collapse all process rows (a body attribute flip;
//     CSS does the rest). Failed/interrupted steps fold too and surface as
//     the red "M 步未成功" counter — expanding reveals them inline.
//
// Counting runs at most ~2.5x/sec (throttled) with a handful of selector
// calls — no layout reads, no per-mutation full scans.
//
// Modes (console: dshFriendlySteps.setMode(...), remembered in localStorage):
//   "minimal"  — fold process rows + hide think (default)
//   "brief"    — only hide think blocks
//   "off"      — everything official
//
// Debug: dshFriendlySteps.debug() logs matching-row counts.
window.__ModuleLoader__.load({
	id: "dsh-friendly-steps",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var ReactDOMClient = require("react-dom/client");

		var MODE_KEY = "dsh-friendly-steps:mode";
		var OPEN_KEY = "dsh-friendly-steps:open";

		// Official DOM contract (dsh-client-ui-conversation / ui-tool):
		//   flow rows:  div[data-chat-flow-kind]
		//   think:      [data-variant="think"] blocks inside assistant-step rows
		//   tool state: [data-tool][data-state] running|ok|error|stopped
		var PROCESS_ROW_SELECTOR =
			'[data-chat-flow-kind="tool-call"],' +
			'[data-chat-flow-kind="tool-result"],' +
			'[data-chat-flow-kind="model-retry"],' +
			'[data-chat-flow-kind="compaction"],' +
			'[data-chat-flow-kind="reasoning"]';
		// An assistant-step row whose only content is think blocks: markdown
		// text always renders block elements (p/pre/ul/h*/table/blockquote),
		// so "has think but no block-level content" == think-only step.
		var THINK_ONLY_STEP_SELECTOR =
			'[data-chat-flow-kind="assistant-step"]' +
			':has([data-variant="think"])' +
			':not(:has(p, pre, ul, ol, dl, h1, h2, h3, h4, h5, h6, table, img, video, blockquote))';
		var FAILURE_SELECTOR = '[data-state="error"], [data-state="stopped"]';
		var RUNNING_SELECTOR = '[data-state="running"]';

		var FOLDED_SELECTOR = PROCESS_ROW_SELECTOR + "," + THINK_ONLY_STEP_SELECTOR;

		var CSS =
			// think blocks: hidden in minimal + brief (unless user expanded all)
			'body[data-dsh-friendly-steps="minimal"]:not([data-dsh-fs-open="1"]) [data-variant="think"],' +
			'body[data-dsh-friendly-steps="brief"] [data-variant="think"]{display:none!important}' +
			// process rows + think-only steps: hidden in minimal unless expanded
			'body[data-dsh-friendly-steps="minimal"]:not([data-dsh-fs-open="1"]) ' +
			PROCESS_ROW_SELECTOR + "{display:none!important}" +
			'body[data-dsh-friendly-steps="minimal"]:not([data-dsh-fs-open="1"]) ' +
			THINK_ONLY_STEP_SELECTOR + "{display:none!important}";

		function getMode() {
			try {
				var m = localStorage.getItem(MODE_KEY);
				return m === "off" || m === "brief" || m === "minimal" ? m : "minimal";
			} catch (e) {
				return "minimal";
			}
		}
		function getOpen() {
			try { return localStorage.getItem(OPEN_KEY) === "1"; } catch (e) { return false; }
		}

		function computeStats() {
			var rows = document.querySelectorAll(FOLDED_SELECTOR);
			var failed = 0;
			var running = false;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].querySelector(FAILURE_SELECTOR)) failed++;
				if (!running && rows[i].querySelector(RUNNING_SELECTOR)) running = true;
			}
			// A streaming think block is itself a running step even before its
			// row matches the fold selectors.
			if (!running && document.querySelector('[data-variant="think"]' + RUNNING_SELECTOR)) running = true;
			return { steps: rows.length, failed: failed, running: running };
		}

		function sameStats(a, b) {
			return a.steps === b.steps && a.failed === b.failed && a.running === b.running;
		}

		// --- tiny external store feeding the pill ----------------------------
		var listeners = [];
		var stats = { steps: 0, failed: 0, running: false };
		var uiTick = 0;
		function subscribe(fn) {
			listeners.push(fn);
			return function () {
				var i = listeners.indexOf(fn);
				if (i !== -1) listeners.splice(i, 1);
			};
		}
		function emit() {
			uiTick++;
			for (var i = 0; i < listeners.length; i++) listeners[i]();
		}
		function refreshStats() {
			var next;
			try { next = computeStats(); } catch (e) { return; }
			if (!sameStats(next, stats)) {
				stats = next;
				emit();
			}
		}

		function syncBodyAttrs() {
			if (!document.body) return;
			document.body.setAttribute("data-dsh-friendly-steps", getMode());
			if (getMode() === "minimal" && getOpen()) document.body.setAttribute("data-dsh-fs-open", "1");
			else document.body.removeAttribute("data-dsh-fs-open");
		}

		// The running-task status card (dsh-task-resilience) renders the step
		// stats itself; when that card is on screen the standalone pill hides so
		// the two never stack. `dsh-friendly-steps:card-visible` lets the card
		// host (task-resilience) re-render its badge when the pill's visibility
		// would flip.
		var taskCardSelector = '[data-dsh-task-resilience]';
		function taskCardVisible() {
			return typeof document !== "undefined" && !!document.querySelector(taskCardSelector);
		}
		function toggleFold() {
			try { localStorage.setItem(OPEN_KEY, getOpen() ? "0" : "1"); } catch (e) {}
			syncBodyAttrs();
			emit();
		}

		// --- the pill ---------------------------------------------------------
		var pillStyle = {
			position: "fixed",
			right: "24px",
			bottom: "calc(var(--dsh-composer-height, 152px) + 12px)",
			zIndex: 40,
			border: "1px solid var(--dsw-alias-border-l2, #e4e7eb)",
			borderRadius: "999px",
			background: "var(--dsw-alias-button-floating-fill, #ffffff)",
			boxShadow: "var(--dsw-shadow-lv2, 0 2px 8px rgba(0,0,0,.08))",
			padding: "4px 12px",
			fontSize: "12px",
			lineHeight: "1.6",
			color: "var(--dsw-alias-label-secondary, #667085)",
			cursor: "pointer",
			userSelect: "none",
			opacity: 0.92,
			fontFamily: "inherit"
		};
		var failStyle = { color: "var(--dsw-alias-text-error, #d92d20)" };

		function Pill() {
			var tick = React.useSyncExternalStore(subscribe, function () { return uiTick; });
			void tick;
			var mode = getMode();
			if (mode !== "minimal") return null;
			if (taskCardVisible()) return null;
			if (stats.steps === 0 && !stats.running) return null;
			var open = getOpen();
			var label = stats.running
				? "⏳ 正在处理…（已进行 " + stats.steps + " 步）"
				: "✓ 已完成 " + stats.steps + " 步";
			return React.createElement(
				"button",
				{
					type: "button",
					style: pillStyle,
					title: open ? "收起过程" : "展开查看过程细节",
					onClick: toggleFold
				},
				label,
				stats.failed > 0
					? React.createElement("span", { style: failStyle }, " · " + stats.failed + " 步未成功")
					: null,
				open ? " ▾" : " ▸"
			);
		}

		function debug() {
			var s = computeStats();
			var info = {
				mode: getMode(),
				open: getOpen(),
				steps: s.steps,
				failed: s.failed,
				running: s.running,
				processRows: document.querySelectorAll(PROCESS_ROW_SELECTOR).length,
				thinkOnlySteps: document.querySelectorAll(THINK_ONLY_STEP_SELECTOR).length,
				thinkBlocks: document.querySelectorAll('[data-variant="think"]').length
			};
			console.log("[friendly-steps]", info);
			return info;
		}

		function start() {
			var style = document.createElement("style");
			style.id = "dsh-friendly-steps-style";
			style.textContent = CSS;
			document.head.appendChild(style);

			var container = document.createElement("div");
			container.setAttribute("data-dsh-friendly-steps-root", "");
			document.body.appendChild(container);
			var root = ReactDOMClient.createRoot(container);
			root.render(React.createElement(Pill));

			syncBodyAttrs();
			refreshStats();

			// Cheap trigger: DOM structure/state changes only, throttled hard.
			// No layout reads, no per-token work — text streaming (characterData)
			// is not observed at all.
			var timer = null;
			var cardVisible = taskCardVisible();
			var observer = new MutationObserver(function () {
				if (timer !== null) return;
				timer = setTimeout(function () {
					timer = null;
					refreshStats();
					// The task-resilience status card mounts/unmounts independently
					// (React slot); flip the pill visibility to match without
					// waiting for a stats change.
					var next = taskCardVisible();
					if (next !== cardVisible) {
						cardVisible = next;
						emit();
					}
				}, 400);
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["data-state"]
			});

			window.dshFriendlySteps = {
				setMode: function (m) {
					try { localStorage.setItem(MODE_KEY, m); } catch (e) {}
					syncBodyAttrs();
					emit();
				},
				getMode: getMode,
				debug: debug,
				// Shared stats store consumed by dsh-task-resilience's status
				// card, so the "已完成 N 步" summary renders inside that card
				// instead of a separate floating pill.
				subscribe: subscribe,
				getStats: function () { return stats; },
				toggle: toggleFold
			};
			// Announce readiness so the status card can adopt the stats as soon
			// as both plugins are mounted (ordering is not guaranteed).
			try { window.dispatchEvent(new CustomEvent("dsh-friendly-steps:ready")); } catch (e) {}

			console.info("[friendly-steps] 过程精简已启用（模式：" + getMode() + "）。切换：dshFriendlySteps.setMode('minimal'|'brief'|'off')");

			return function dispose() {
				observer.disconnect();
				if (timer !== null) clearTimeout(timer);
				root.unmount();
				container.remove();
				if (style.parentNode) style.parentNode.removeChild(style);
				if (document.body) {
					document.body.removeAttribute("data-dsh-friendly-steps");
					document.body.removeAttribute("data-dsh-fs-open");
				}
				try { delete window.dshFriendlySteps; } catch (e) { window.dshFriendlySteps = void 0; }
			};
		}

		function apply(ctx) {
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(function () { return start(); }, "friendly-steps: boot");
				return;
			}
			start();
		}

		var inject = [];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
