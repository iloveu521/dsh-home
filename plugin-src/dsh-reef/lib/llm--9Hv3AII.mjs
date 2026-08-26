//#region src/lib/llm.ts
/**
* 用 ctx.llm 跑一次文本生成。模型选择顺序:spec({provider,model}) → agent 默认模型。
*/
async function runLlm(ctx, spec, system, prompt, signal, options = {}) {
	const llm = ctx.get("llm");
	if (llm === void 0) throw new Error("llm service unavailable");
	const overrides = spec ?? {};
	let provider = overrides.provider;
	let model = overrides.model;
	if (!provider || !model) try {
		const selection = ctx.get("agentDefaultModel")?.currentSelection();
		provider = provider ?? selection?.provider;
		model = model ?? selection?.model;
	} catch {}
	if (!provider || !model) throw new Error("no review model configured (set reef.*.reviewModel or a default model)");
	const chunks = llm.stream({
		provider,
		model,
		system,
		messages: [{
			role: "user",
			content: prompt
		}],
		maxTokens: options.maxTokens ?? 2e3,
		signal
	});
	let text = "";
	for await (const chunk of chunks) if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
	return text.trim();
}
//#endregion
export { runLlm as t };
