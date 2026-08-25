/**
 * dsh-status-card host half.
 *
 * Registers one human slash command `/status` over the shared command
 * registry (`ctx.commands`, the same seam as the built-in `/compact`). The
 * handler never touches a model turn: it reads the session's token-meter
 * projections for a compact summary line (rendered durably in the flow) and
 * settles immediately. The live card above the composer is drawn by the
 * client half (lib/client.js), which reacts to the newest `/status` run in
 * the conversation window and streams projection values on its own.
 */

export const name = 'dsh-status-card';
export const inject = ['commands'];

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

/** One-line summary off the session's token-meter projections; empty when nothing was measured yet. */
function summarize(ctx, invocation) {
	const parts = [];
	try {
		const projections = ctx.get('sessionProjections');
		if (projections && typeof projections.snapshot === 'function') {
			const snapshot = projections.snapshot(invocation.agent.session);
			const values = (snapshot && snapshot.values) || {};
			const pressure = values.contextPressure;
			const usage = values.tokenUsage;
			const capacity = pressure && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : undefined;
			const projected =
				pressure && typeof pressure.projectedTokens === 'number'
					? pressure.projectedTokens
					: pressure && typeof pressure.pressureTokens === 'number'
						? pressure.pressureTokens
						: undefined;
			if (capacity > 0 && projected !== undefined) {
				const percent = Math.min(100, Math.round((projected / capacity) * 100));
				parts.push(`上下文 ${percent}%（${formatTokens(projected)}/${formatTokens(capacity)}）`);
			}
			if (usage) {
				parts.push(
					`输入 ${formatTokens(usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)}`,
					`输出 ${formatTokens(usage.outputTokens)}`,
				);
			}
		}
	} catch (error) {
		console.error('[dsh-status-card] projection read failed:', error);
	}
	return parts.length > 0
		? `已在输入框上方显示状态卡片 — ${parts.join(' · ')}`
		: '已在输入框上方显示状态卡片（会话暂无用量数据）';
}

export function apply(ctx) {
	ctx.effect(
		() =>
			ctx.commands.register({
				name: 'status',
				description: '在输入框上方显示上下文与 Token 用量卡片',
				recordInput: false,
				handler: (invocation) => ({ kind: 'success', text: summarize(ctx, invocation) }),
			}),
		'dsh-status-card: /status command',
	);
}
