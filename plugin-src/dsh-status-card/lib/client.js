/**
 * dsh-status-card client half.
 *
 * Watches the conversation snapshot for the newest `/status` command run and
 * renders a live usage card in the `conversation.input.dock` seat (the
 * full-width row stacked directly above the composer card). All numbers come
 * from the session-projection standard kit (`useProjection`) and refresh by
 * themselves as push frames land; the card hides via its close button until
 * the next `/status` run (per browser tab, in memory).
 */
window.__ModuleLoader__.load({
	id: 'dsh-status-card',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		const PLUGIN_ID = 'dsh-status-card';
		const DOCK_ID = 'dsh-status-card';
		const COMMAND_NAME = 'status';

		if (document.querySelector(`style[data-plugin-css="${PLUGIN_ID}"]`) === null) {
			const style = document.createElement('style');
			style.dataset.plugin = PLUGIN_ID;
			style.dataset.pluginCss = PLUGIN_ID;
			style.textContent = `
.dshsc-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px)*2 - var(--dsh-composer-dock-inset,8px)*4);max-width:calc(var(--dsh-composer-card-max-width,780px) - var(--dsh-composer-dock-inset,8px)*2);margin:0 auto;flex:none}
.dshsc-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip,#f6f6f6);border-radius:12px;padding:8px 14px 9px;display:flex;flex-direction:column;gap:7px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshsc-head{display:flex;align-items:center;gap:8px}
.dshsc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.dshsc-title{color:var(--dsw-alias-label-primary);font-weight:500}
.dshsc-updated{color:var(--dsw-alias-label-caption);font-size:12px;margin-left:auto;white-space:nowrap}
.dshsc-close{flex:none;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0;font-size:15px;line-height:1}
.dshsc-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsc-meter{display:flex;align-items:center;gap:10px}
.dshsc-bar{flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshsc-fill{height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.dshsc-fill[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}
.dshsc-fill[data-tone="danger"]{background:var(--dsw-alias-state-error-primary)}
.dshsc-pct{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600;min-width:40px;text-align:right}
.dshsc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px 16px}
.dshsc-key{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;letter-spacing:.02em}
.dshsc-val{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums;line-height:20px}
.dshsc-sub{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-top:1px}
.dshsc-comp{color:var(--dsw-alias-label-caption);font-size:12px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}
.dshsc-waiting{color:var(--dsw-alias-label-caption);font-size:12px}
`;
			document.head.appendChild(style);
		}

		const COPY = {
			zh: {
				title: '会话状态',
				updated: '更新于',
				dismiss: '收起卡片（再次运行 /status 可重新显示）',
				context: '上下文窗口',
				inputBilled: '累计输入（计费）',
				output: '累计输出',
				cacheHit: '缓存命中率',
				cacheRead: '缓存读',
				cacheWrite: '缓存写',
				uncached: '未缓存',
				compTitle: '组成估算',
				system: '系统提示',
				tools: '工具定义',
				messages: '对话内容',
				waiting: '等待首次模型请求上报用量…',
			},
			en: {
				title: 'Session status',
				updated: 'Updated',
				dismiss: 'Dismiss card (run /status again to reopen)',
				context: 'Context window',
				inputBilled: 'Input (billed)',
				output: 'Output',
				cacheHit: 'Cache hit',
				cacheRead: 'cache read',
				cacheWrite: 'cache write',
				uncached: 'uncached',
				compTitle: 'Composition (est.)',
				system: 'system',
				tools: 'tools',
				messages: 'messages',
				waiting: 'Waiting for the first request to report usage…',
			},
		};

		/** Dismissed `/status` runs for this tab (memory only; a new run reopens the card). */
		const dismissed = new Set();

		let localeService = null;

		function copyOf() {
			try {
				const snapshot = localeService && typeof localeService.getLocale === 'function' ? localeService.getLocale() : null;
				if (snapshot && typeof snapshot.active === 'string' && !snapshot.active.toLowerCase().startsWith('zh')) return COPY.en;
			} catch {
				// locale service absent or not ready — fall through to zh
			}
			return COPY.zh;
		}

		/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
		function formatTokens(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return '—';
			const abs = Math.abs(n);
			if (abs < 1000) return String(Math.round(n));
			if (abs < 100000) return `${(n / 1000).toFixed(1)}K`;
			if (abs < 1000000) return `${Math.round(n / 1000)}K`;
			return `${(n / 1000000).toFixed(2)}M`;
		}

		/** Newest settled `/status` run in the visible conversation window (or null). */
		function findLatestStatusNode(session) {
			const nodes = session && Array.isArray(session.nodes) ? session.nodes : [];
			for (let i = nodes.length - 1; i >= 0; i--) {
				const node = nodes[i];
				if (node && node.kind === 'command' && node.name === COMMAND_NAME) return node;
			}
			return null;
		}

		function pickProjectedTokens(pressure) {
			if (!pressure) return undefined;
			if (typeof pressure.projectedTokens === 'number') return pressure.projectedTokens;
			if (typeof pressure.pressureTokens === 'number') return pressure.pressureTokens;
			return undefined;
		}

		function formatClock(ms) {
			try {
				return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			} catch {
				return '';
			}
		}

		function StatCell({ label, value, sub }) {
			return h(
				'div',
				{ className: 'dshsc-cell' },
				h('div', { className: 'dshsc-key' }, label),
				h('div', { className: 'dshsc-val' }, value),
				sub ? h('div', { className: 'dshsc-sub' }, sub) : null,
			);
		}

		function StatusDock(props) {
			const [, setTick] = React.useState(0);
			React.useEffect(() => {
				if (!localeService || typeof localeService.subscribe !== 'function') return undefined;
				return localeService.subscribe(() => setTick((tick) => tick + 1));
			}, []);

			// Hooks run unconditionally before any early return.
			const pressure = props.useProjection('contextPressure');
			const usage = props.useProjection('tokenUsage');
			const breakdown = props.useProjection('contextBreakdown');

			const node = findLatestStatusNode(props.session);
			if (!node || !node.outcome || node.outcome.kind !== 'success') return null;
			if (dismissed.has(node.commandId)) return null;

			const copy = copyOf();
			const capacity = pressure && typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0 ? pressure.contextWindow : undefined;
			const projected = pickProjectedTokens(pressure);
			const percent =
				capacity !== undefined && projected !== undefined
					? Math.min(100, Math.max(0, Math.round((projected / capacity) * 100)))
					: null;
			const tone = percent === null ? undefined : percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : undefined;

			const hasUsage = !!usage;
			const uncached = hasUsage ? Number(usage.uncachedInputTokens) || 0 : 0;
			const cacheRead = hasUsage ? Number(usage.cacheReadTokens) || 0 : 0;
			const cacheWrite = hasUsage ? Number(usage.cacheWriteTokens) || 0 : 0;
			const output = hasUsage ? Number(usage.outputTokens) || 0 : 0;
			const billed = uncached + cacheRead + cacheWrite;
			const cacheHitPercent = hasUsage && billed > 0 ? Math.round((cacheRead / billed) * 100) : null;

			const b = breakdown || {};
			const hasBreakdown =
				typeof b.systemTokens === 'number' || typeof b.toolsTokens === 'number' || typeof b.messageTokens === 'number';

			const onDismiss = () => {
				dismissed.add(node.commandId);
				setTick((tick) => tick + 1);
			};

			return h(
				'div',
				{ className: 'dshsc-dock' },
				h(
					'div',
					{ className: 'dshsc-card' },
					h(
						'div',
						{ className: 'dshsc-head' },
						h('span', { className: 'dshsc-dot' }),
						h('span', { className: 'dshsc-title' }, copy.title),
						h('span', { className: 'dshsc-updated' }, `${copy.updated} ${formatClock(node.time)}`),
						h('button', {
							className: 'dshsc-close',
							title: copy.dismiss,
							'aria-label': copy.dismiss,
							onClick: onDismiss,
						}, '×'),
					),
					percent !== null
						? h(
								'div',
								{ className: 'dshsc-meter' },
								h('div', { className: 'dshsc-bar' }, h('div', { className: 'dshsc-fill', 'data-tone': tone, style: { width: `${percent}%` } })),
								h('span', { className: 'dshsc-pct' }, `${percent}%`),
							)
						: h('div', { className: 'dshsc-waiting' }, copy.waiting),
					h(
						'div',
						{ className: 'dshsc-grid' },
						h(StatCell, {
							label: copy.context,
							value: projected !== undefined ? `${formatTokens(projected)} / ${capacity !== undefined ? formatTokens(capacity) : '—'}` : '—',
						}),
						h(StatCell, {
							label: copy.inputBilled,
							value: hasUsage ? formatTokens(billed) : '—',
							sub: hasUsage ? `${copy.cacheRead} ${formatTokens(cacheRead)} · ${copy.cacheWrite} ${formatTokens(cacheWrite)} · ${copy.uncached} ${formatTokens(uncached)}` : undefined,
						}),
						h(StatCell, { label: copy.output, value: hasUsage ? formatTokens(output) : '—' }),
						h(StatCell, { label: copy.cacheHit, value: cacheHitPercent !== null ? `${cacheHitPercent}%` : '—' }),
					),
					hasBreakdown
						? h(
								'div',
								{ className: 'dshsc-comp' },
								`${copy.compTitle}：${copy.system} ${formatTokens(b.systemTokens)} · ${copy.tools} ${formatTokens(b.toolsTokens)} · ${copy.messages} ${formatTokens(b.messageTokens)}`,
							)
						: null,
				),
			);
		}

		const inject = ['slots'];

		function apply(ctx) {
			localeService = ctx.get('locale') ?? null;
			ctx.slots.inject('conversation.input.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.dock',
						id: DOCK_ID,
						order: 10,
					},
					StatusDock,
				),
			);
		}

		return { apply, inject };
	},
});
