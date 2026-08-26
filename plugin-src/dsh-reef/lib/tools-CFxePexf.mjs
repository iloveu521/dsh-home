//#region src/lib/tools.ts
/**
* Resolve the workspace working directory for one tool execution.
* Prefers the calling agent's session cwd; falls back to the host process cwd.
*/
function workspaceCwd(exec) {
	try {
		const cwd = exec?.agent?.session?.meta?.cwd;
		if (typeof cwd === "string" && cwd.length > 0) return cwd;
	} catch {}
	return process.cwd();
}
/**
* Build a plain ToolDefinition for `ctx.tools.register` without depending on
* any @deepseek-ai package (max version-alignment tolerance).
*/
function definePlainTool(options) {
	const render = options.render ?? ((_args, value) => JSON.stringify(value, null, 2));
	const definition = {
		name: options.name,
		description: options.description,
		parameters: options.parameters,
		output: {
			schema: options.outputSchema ?? { type: "object" },
			render: (args, value) => [{
				type: "text",
				text: render(args, value)
			}]
		},
		execute: options.execute
	};
	if (options.presentCall !== void 0) definition.presentCall = options.presentCall;
	if (options.concurrencySafe) definition.isConcurrencySafe = () => true;
	if (options.timeoutMs !== void 0) definition.timeoutMs = options.timeoutMs;
	return definition;
}
/** Generic card view used by most dsh-reef tools. */
function genericCard(kind, title, rawInput) {
	return {
		card: "generic",
		kind,
		title,
		rawInput
	};
}
//#endregion
export { genericCard as n, workspaceCwd as r, definePlainTool as t };
