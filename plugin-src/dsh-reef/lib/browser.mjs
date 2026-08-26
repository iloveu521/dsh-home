import { c as sendJson, d as resolveConfig, l as sendText, r as sectionOverrides, t as handleModuleSettings, u as urlPath } from "./settings-BKR5a7Xr.mjs";
import { n as genericCard, r as workspaceCwd, t as definePlainTool } from "./tools-CFxePexf.mjs";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
//#region src/browser/settings.ts
const BROWSER_SETTING_FIELDS = [
	{
		key: "headless",
		label: "无头模式",
		type: "boolean",
		defaultValue: true
	},
	{
		key: "channel",
		label: "浏览器通道",
		type: "enum",
		options: [
			"auto",
			"msedge",
			"chrome",
			"chromium"
		],
		defaultValue: "auto"
	},
	{
		key: "screenshotDir",
		label: "截图目录",
		type: "string",
		defaultValue: ".dsh-reef/screenshots"
	},
	{
		key: "screenshotMaxAgeDays",
		label: "截图保留天数(0=不按时间清理)",
		type: "number",
		defaultValue: 7
	},
	{
		key: "screenshotMaxCount",
		label: "截图保留数量(0=不按数量清理)",
		type: "number",
		defaultValue: 200
	},
	{
		key: "timeoutMs",
		label: "操作超时(毫秒)",
		type: "number",
		defaultValue: 3e4
	},
	{
		key: "liveViewPath",
		label: "实时画面 API 路径",
		type: "string",
		restart: true,
		defaultValue: "/reef/browser"
	}
];
//#endregion
//#region src/browser/session.ts
/** 当前活动 profile 名(默认 "default")。 */
let currentProfile = "default";
/** 多配置文件浏览器会话:name → 会话状态。 */
const profileStates = /* @__PURE__ */ new Map();
/** 最近下载记录 [{ download, suggestedFilename, at }](按 profile 名隔离)。 */
const downloadsByProfile = /* @__PURE__ */ new Map();
/** 页面访问历史(按 profile 名隔离)。不随 closeBrowser 清空,DSH 重启才重置。 */
const historyByProfile = /* @__PURE__ */ new Map();
/** 已保存的表单回放:name → fields 数组。 */
const savedForms = /* @__PURE__ */ new Map();
/** 最近一次 browser_form 填充的字段(供 browser_form_save 无参保存)。 */
let lastFormFields = [];
function profileConfig(config, name) {
	const named = config.profiles?.[name];
	if (!named || typeof named !== "object") return { ...config };
	return {
		...config,
		...named,
		profiles: config.profiles
	};
}
function getProfileState(name) {
	let state = profileStates.get(name);
	if (state === void 0) {
		state = {
			browser: null,
			context: null,
			persistent: false,
			pages: /* @__PURE__ */ new Map(),
			activeId: null,
			counter: 0
		};
		profileStates.set(name, state);
	}
	return state;
}
function downloadsOf(name) {
	let list = downloadsByProfile.get(name);
	if (list === void 0) {
		list = [];
		downloadsByProfile.set(name, list);
	}
	return list;
}
/** 某 profile 的访问历史(按时间先后)。 */
function historyOf(name) {
	let list = historyByProfile.get(name);
	if (list === void 0) {
		list = [];
		historyByProfile.set(name, list);
	}
	return list;
}
/** 把一次主 frame 导航记入该 profile 的访问历史(去重 + 上限 50 条)。 */
function recordNav(profile, url) {
	const list = historyOf(profile);
	const last = list[list.length - 1];
	if (last !== void 0 && last.url === url) {
		last.ts = Date.now();
		return last;
	}
	const entry = {
		url,
		title: "",
		ts: Date.now()
	};
	list.push(entry);
	if (list.length > 50) list.shift();
	return entry;
}
/** 面板 ⚙ 设置区对浏览器模块的运行时覆盖(已按白名单校验)。 */
function browserOverrides() {
	return sectionOverrides("browser", BROWSER_SETTING_FIELDS);
}
function attachPage(page, config) {
	const ov = browserOverrides();
	const timeoutMs = typeof ov.timeoutMs === "number" ? ov.timeoutMs : config.timeoutMs ?? 3e4;
	page.setDefaultTimeout(timeoutMs);
	page.on("download", (download) => {
		const list = downloadsOf(currentProfile);
		list.push({
			download,
			suggestedFilename: download.suggestedFilename(),
			at: Date.now()
		});
		if (list.length > 20) list.shift();
	});
	const profile = currentProfile;
	page.on("framenavigated", (frame) => {
		if (frame !== page.mainFrame()) return;
		const url = frame.url();
		if (!url || url === "about:blank") return;
		recordNav(profile, url);
	});
	page.on("load", () => {
		const list = historyOf(profile);
		const entry = list[list.length - 1];
		if (entry === void 0) return;
		page.title().then((t) => {
			if (t) entry.title = t;
		}).catch(() => {});
	});
}
async function loadPlaywright() {
	try {
		return await import("playwright-core");
	} catch {
		throw new Error("dsh-reef/browser: playwright-core is not installed. Run `dsh plugin --profile web add playwright-core` or install it in the profile.");
	}
}
async function launchProfile(name, config) {
	const pw = await loadPlaywright();
	const state = getProfileState(name);
	const ov = browserOverrides();
	const resolved = {
		...profileConfig(config, name),
		..."headless" in ov ? { headless: ov.headless } : {},
		..."channel" in ov ? { channel: ov.channel } : {}
	};
	const base = { headless: resolved.headless ?? true };
	const candidates = [];
	if (resolved.executablePath) candidates.push({
		...base,
		executablePath: resolved.executablePath
	});
	else if (resolved.channel && resolved.channel !== "auto") candidates.push({
		...base,
		channel: resolved.channel
	});
	else {
		const order = process.platform === "win32" ? [
			"msedge",
			"chrome",
			"chromium"
		] : [
			"chrome",
			"msedge",
			"chromium"
		];
		for (const channel of order) candidates.push({
			...base,
			channel
		});
		candidates.push(base);
	}
	let lastError;
	for (const options of candidates) try {
		if (resolved.userDataDir) {
			const context = await pw.chromium.launchPersistentContext(resolved.userDataDir, {
				...options,
				headless: resolved.headless ?? true
			});
			for (const existing of context.pages()) existing.close().catch(() => {});
			state.browser = null;
			state.context = context;
			state.persistent = true;
			state.channel = options.channel ?? options.executablePath ?? "bundled";
			return;
		}
		state.browser = await pw.chromium.launch(options);
		state.context = null;
		state.persistent = false;
		state.channel = options.channel ?? options.executablePath ?? "bundled";
		return;
	} catch (error) {
		lastError = error;
	}
	throw new Error(`dsh-reef/browser: could not launch a Chromium-based browser. Install one, set config executablePath, or run \`npx playwright install chromium\`. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
/** 当前 profile 状态(未启动时创建空状态)。 */
function stateOf() {
	return getProfileState(currentProfile);
}
/** 新建一个页面(当前 profile 会话未启动时先启动)。 */
async function newPage(config) {
	const state = stateOf();
	profileConfig(config, currentProfile);
	if (state.browser === null && state.context === null) await launchProfile(currentProfile, config);
	const context = state.context;
	const browser = state.browser;
	if (context !== null) {
		const page = await context.newPage();
		attachPage(page, config);
		return page;
	}
	if (browser !== null) {
		const page = await browser.newPage();
		attachPage(page, config);
		return page;
	}
	throw new Error("dsh-reef/browser: browser session failed to start");
}
/** 返回当前活动页面(没有则新建),并保证浏览器已启动。 */
async function getPage(config) {
	const state = stateOf();
	if (state.browser === null && state.context === null) await launchProfile(currentProfile, config);
	if (state.pages.size === 0) {
		const page = await newPage(config);
		const id = state.counter++;
		state.pages.set(id, page);
		state.activeId = id;
	}
	const page = state.pages.get(state.activeId ?? -1);
	if (page === void 0) throw new Error("dsh-reef/browser: no active page");
	return page;
}
/** 活动页面(可能为 null,不触发启动)。 */
function activePage() {
	const state = stateOf();
	return state.pages.get(state.activeId ?? -1) ?? null;
}
/** 投影当前 profile 的标签列表。 */
async function tabList() {
	const state = stateOf();
	const tabs = [];
	for (const [id, page] of state.pages) {
		let title = "";
		try {
			title = await page.title();
		} catch {}
		tabs.push({
			id,
			url: page.url(),
			title
		});
	}
	return tabs;
}
async function closeBrowser() {
	for (const [name, state] of profileStates) {
		const { browser, context } = state;
		state.browser = null;
		state.context = null;
		state.pages = /* @__PURE__ */ new Map();
		state.activeId = null;
		state.counter = 0;
		try {
			if (context !== null) await context.close();
			else if (browser !== null) await browser.close();
		} catch {}
	}
	profileStates.clear();
	downloadsByProfile.clear();
}
/** Best-effort current page identity, safe when nothing is open. */
async function pageIdentity(page) {
	try {
		return {
			url: page.url(),
			title: await page.title()
		};
	} catch {
		return {
			url: "",
			title: ""
		};
	}
}
/** 设置最近一次表单填充(供 browser_form_save 无参保存)。 */
function setLastFormFields(fields) {
	lastFormFields = fields;
}
/** 切换当前 profile。 */
function setCurrentProfile(name) {
	currentProfile = name;
}
/** 最近一次 browser_screenshot 实际写入的目录(供定时清扫复用,避免相对路径解析漂移)。 */
let lastScreenshotDir = null;
/** 记录最近一次截图目录(截图工具调用时写入)。 */
function noteScreenshotDir(dir) {
	lastScreenshotDir = dir;
}
/** 定时清扫入口:若已知截图目录则按当前配置清理。 */
function sweepScreenshotDir(opts) {
	if (lastScreenshotDir === null) return 0;
	return cleanupScreenshots(lastScreenshotDir, opts);
}
/**
* 清理截图目录里的 .png 文件:按修改时间保留最新的 maxCount 个,
* 并删除超过 maxAgeDays 天的旧文件。只处理目录直属文件,不递归;
* 单个文件删除失败(被占用等)静默跳过。返回删除数量。
*/
function cleanupScreenshots(dir, opts) {
	const maxAgeDays = Number(opts.maxAgeDays ?? 0) || 0;
	const maxCount = Math.max(0, Number(opts.maxCount ?? 0) || 0);
	if (maxAgeDays <= 0 && maxCount <= 0) return 0;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 864e5 : 0;
	const files = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!/\.png$/i.test(entry.name)) continue;
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(join(dir, entry.name)).mtimeMs;
		} catch {
			continue;
		}
		files.push({
			name: entry.name,
			mtimeMs
		});
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	let removed = 0;
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		if (!(cutoff > 0 && file.mtimeMs < cutoff) && !(maxCount > 0 && i >= maxCount)) continue;
		try {
			rmSync(join(dir, file.name), { force: true });
			removed++;
		} catch {}
	}
	return removed;
}
//#endregion
//#region src/browser/tools.ts
async function openTool(config, args) {
	const page = await getPage(config);
	await page.goto(String(args.url), {
		waitUntil: args.waitUntil ?? "domcontentloaded",
		timeout: args.timeoutMs ?? config.timeoutMs
	});
	return {
		url: page.url(),
		title: await page.title(),
		status: "ok"
	};
}
async function snapshotTool(config, args) {
	const page = await getPage(config);
	const maxText = args.maxTextChars ?? config.maxTextChars;
	const maxLinks = args.maxLinks ?? config.maxLinks;
	const data = await page.evaluate(([maxT, maxL]) => {
		const text = document.body ? document.body.innerText : "";
		const links = Array.from(document.querySelectorAll("a")).slice(0, maxL).map((a) => ({
			text: (a.innerText || a.textContent || "").trim().slice(0, 200),
			href: a.href
		}));
		const inputs = document.querySelectorAll("input, textarea, select").length;
		return {
			text: text.slice(0, maxT),
			truncated: text.length > maxT,
			links,
			inputs
		};
	}, [maxText, maxLinks]);
	return {
		url: page.url(),
		title: await page.title(),
		...data
	};
}
async function clickTool(config, args) {
	const page = await getPage(config);
	const selector = String(args.selector);
	await page.click(selector, { timeout: args.timeoutMs ?? config.timeoutMs });
	await page.waitForLoadState("domcontentloaded").catch(() => {});
	return {
		clicked: selector,
		...await pageIdentity(page)
	};
}
async function typeTool(config, args) {
	const page = await getPage(config);
	const selector = String(args.selector);
	const text = String(args.text ?? "");
	if (args.clear === true) await page.fill(selector, text, { timeout: args.timeoutMs ?? config.timeoutMs });
	else {
		await page.click(selector, { timeout: args.timeoutMs ?? config.timeoutMs });
		await page.keyboard.type(text, { delay: args.delayMs ?? 0 });
	}
	if (args.submit === true) await page.keyboard.press("Enter");
	return {
		typed: true,
		selector,
		submit: args.submit === true,
		...await pageIdentity(page)
	};
}
async function pressTool(config, args) {
	const page = await getPage(config);
	const key = String(args.key);
	if (args.selector) await page.press(String(args.selector), key, { timeout: args.timeoutMs ?? config.timeoutMs });
	else await page.keyboard.press(key);
	return {
		pressed: key,
		...await pageIdentity(page)
	};
}
async function evalTool(config, args) {
	const page = await getPage(config);
	const script = String(args.script ?? "");
	const wrapped = /[\n;]|^\s*return\b/.test(script) ? `(async () => {\n${script}\n})()` : `(${script})`;
	const raw = await page.evaluate(wrapped);
	let result;
	try {
		result = JSON.parse(JSON.stringify(raw ?? null));
	} catch {
		result = raw === void 0 ? null : String(raw);
	}
	return { result };
}
async function screenshotTool(config, args, exec) {
	const page = await getPage(config);
	const cwd = workspaceCwd(exec);
	const ov = browserOverrides();
	const screenshotDir = typeof ov.screenshotDir === "string" && ov.screenshotDir ? ov.screenshotDir : config.screenshotDir ?? ".dsh-reef/screenshots";
	const dir = isAbsolute(screenshotDir) ? screenshotDir : resolve(cwd, screenshotDir);
	mkdirSync(dir, { recursive: true });
	const safeName = String(args.name ?? `shot-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, "_");
	const fileName = safeName.endsWith(".png") ? safeName : `${safeName}.png`;
	const filePath = join(dir, fileName);
	const buffer = await page.screenshot({ type: "png" });
	writeFileSync(filePath, buffer);
	noteScreenshotDir(dir);
	cleanupScreenshots(dir, {
		maxAgeDays: typeof ov.screenshotMaxAgeDays === "number" ? ov.screenshotMaxAgeDays : config.screenshotMaxAgeDays,
		maxCount: typeof ov.screenshotMaxCount === "number" ? ov.screenshotMaxCount : config.screenshotMaxCount
	});
	const viewport = page.viewportSize() ?? {
		width: 0,
		height: 0
	};
	return {
		path: filePath,
		bytes: buffer.length,
		width: viewport.width,
		height: viewport.height
	};
}
async function waitTool(config, args) {
	const page = await getPage(config);
	const ms = Math.max(0, Math.min(Number(args.ms ?? 1e3) || 0, 6e4));
	await page.waitForTimeout(ms);
	return {
		waitedMs: ms,
		...await pageIdentity(page)
	};
}
async function backTool(config) {
	const page = await getPage(config);
	await page.goBack().catch(() => {});
	return { ...await pageIdentity(page) };
}
async function reloadTool(config) {
	const page = await getPage(config);
	await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
	return { ...await pageIdentity(page) };
}
async function statusTool() {
	const page = activePage();
	const state = stateOf();
	const profiles = [];
	for (const [name, s] of profileStates) profiles.push({
		name,
		open: s.browser !== null || s.context !== null,
		tabs: s.pages.size,
		channel: s.channel ?? "",
		persistent: s.persistent
	});
	if (page === null) return {
		open: false,
		profile: currentProfile,
		channel: state.channel ?? "",
		tabs: 0,
		profiles
	};
	return {
		open: true,
		profile: currentProfile,
		channel: state.channel ?? "",
		tabs: state.pages.size,
		profiles,
		...await pageIdentity(page)
	};
}
async function tabsTool(config, args) {
	const action = args.action ?? "list";
	const state = stateOf();
	if (state.browser === null && state.context === null && action !== "list") await launchProfile(currentProfile, config);
	if (state.browser === null && state.context === null) return {
		action,
		tabs: [],
		activeId: -1
	};
	switch (action) {
		case "list": return {
			action,
			tabs: await tabList(),
			activeId: state.activeId ?? -1
		};
		case "new": {
			const page = await newPage(config);
			const id = state.counter++;
			state.pages.set(id, page);
			state.activeId = id;
			if (args.url) await page.goto(String(args.url), {
				waitUntil: args.waitUntil ?? "domcontentloaded",
				timeout: args.timeoutMs ?? config.timeoutMs
			});
			return {
				action,
				tab: {
					id,
					url: page.url(),
					title: await page.title()
				},
				tabs: await tabList(),
				activeId: state.activeId
			};
		}
		case "switch": {
			const id = resolveTabId(args);
			if (!state.pages.has(id)) throw new Error(`no tab with id ${id}`);
			state.activeId = id;
			return {
				action,
				activeId: state.activeId,
				tabs: await tabList()
			};
		}
		case "close": {
			const id = resolveTabId(args);
			const page = state.pages.get(id);
			if (page === void 0) throw new Error(`no tab with id ${id}`);
			await page.close().catch(() => {});
			state.pages.delete(id);
			if (state.activeId === id) {
				const next = state.pages.keys().next().value;
				state.activeId = next === void 0 ? null : next;
			}
			return {
				action,
				activeId: state.activeId ?? -1,
				tabs: await tabList()
			};
		}
		default: throw new Error(`unknown tabs action: ${action}`);
	}
}
function resolveTabId(args) {
	const state = stateOf();
	if (args.id !== void 0) return Number(args.id);
	if (args.index !== void 0) {
		const ids = [...state.pages.keys()];
		const idx = Number(args.index);
		if (idx < 0 || idx >= ids.length) throw new Error(`tab index ${idx} out of range`);
		return ids[idx];
	}
	if (state.activeId !== null) return state.activeId;
	throw new Error("no tab id/index given and no active tab");
}
async function downloadTool(config, args, exec) {
	const recentDownloads = downloadsOf(currentProfile);
	if (recentDownloads.length === 0) throw new Error("no recent downloads. Trigger a download in the page first (e.g. browser_click on a download link).");
	const index = args.index !== void 0 ? Number(args.index) : recentDownloads.length - 1;
	const entry = recentDownloads[index];
	if (entry === void 0) throw new Error(`no download at index ${index}`);
	const cwd = workspaceCwd(exec);
	const downloadDir = config.downloadDir ?? ".dsh-reef/downloads";
	const dir = isAbsolute(downloadDir) ? downloadDir : resolve(cwd, downloadDir);
	mkdirSync(dir, { recursive: true });
	const safe = String(entry.suggestedFilename || `download-${Date.now()}`).replace(/[\\/:*?"<>|]/g, "_");
	const filePath = join(dir, safe);
	if (!filePath.startsWith(resolve(dir))) throw new Error(`download path escapes directory: ${filePath}`);
	await entry.download.saveAs(filePath);
	return {
		path: filePath,
		filename: safe,
		url: entry.download.url() ?? "",
		bytes: statSync(filePath).size
	};
}
async function uploadTool(config, args, exec) {
	const page = await getPage(config);
	const cwd = workspaceCwd(exec);
	const filePath = isAbsolute(args.path) ? String(args.path) : resolve(cwd, String(args.path));
	let stat;
	try {
		stat = statSync(filePath);
	} catch {
		throw new Error(`file not found: ${filePath}`);
	}
	if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
	const resolvedPath = resolve(filePath);
	await page.setInputFiles(String(args.selector), resolvedPath, { timeout: args.timeoutMs ?? config.timeoutMs });
	return {
		uploaded: filePath,
		bytes: stat.size,
		...await pageIdentity(page)
	};
}
async function cookiesTool(config, args) {
	const page = await getPage(config);
	const context = page.context();
	const action = args.action ?? "list";
	if (action === "list") return { cookies: (await context.cookies(args.url ?? page.url())).map((c) => ({
		name: c.name,
		value: args.showValues === true ? c.value : "(hidden — set showValues=true to reveal)",
		domain: c.domain,
		path: c.path,
		httpOnly: c.httpOnly,
		secure: c.secure,
		sameSite: c.sameSite,
		expires: c.expires
	})) };
	if (action === "set") {
		if (!args.name || args.value === void 0) throw new Error("set requires name and value");
		await context.addCookies([{
			name: String(args.name),
			value: String(args.value),
			url: args.url ?? page.url()
		}]);
		return {
			set: true,
			name: String(args.name),
			url: args.url ?? page.url()
		};
	}
	if (action === "clear") {
		await context.clearCookies();
		return { cleared: true };
	}
	throw new Error(`unknown cookies action: ${action}`);
}
async function formTool(config, args) {
	const page = await getPage(config);
	let fields = args.fields ?? [];
	if (!Array.isArray(fields) || fields.length === 0) {
		if (typeof args.from === "string" && savedForms.has(args.from)) fields = savedForms.get(args.from);
		else throw new Error("fields must be a non-empty array (or pass from=<saved form name>)");
	}
	const filled = [];
	for (const field of fields) {
		const value = String(field.value ?? "");
		if (field.selector) {
			await page.fill(String(field.selector), value, { timeout: args.timeoutMs ?? config.timeoutMs });
			filled.push({ selector: field.selector });
		} else if (field.label) {
			await page.getByLabel(String(field.label), { exact: true }).fill(value);
			filled.push({ label: field.label });
		} else throw new Error("each field needs a selector or a label");
	}
	setLastFormFields(fields.map((f) => ({ ...f })));
	if (args.submit === true) await page.keyboard.press("Enter");
	return {
		filled,
		submit: args.submit === true,
		...await pageIdentity(page)
	};
}
async function formSaveTool(args) {
	let fields = args.fields;
	if (!Array.isArray(fields) || fields.length === 0) {
		if (lastFormFields.length === 0) throw new Error("no fields given and no previous browser_form to remember");
		fields = lastFormFields;
	}
	const name = String(args.name ?? "");
	if (!name) throw new Error("name is required");
	savedForms.set(name, fields.map((f) => ({ ...f })));
	return {
		saved: name,
		fields: fields.length
	};
}
async function formsTool(args) {
	const action = args.action ?? "list";
	if (action === "list") return { forms: [...savedForms.entries()].map(([name, fields]) => ({
		name,
		fields: fields.length,
		preview: fields.slice(0, 3).map((f) => f.selector ?? f.label ?? "?").join(", ")
	})) };
	if (action === "delete") {
		if (!args.name) throw new Error("name is required");
		return {
			deleted: savedForms.delete(String(args.name)),
			name: String(args.name)
		};
	}
	throw new Error(`unknown forms action: ${action}`);
}
async function profileTool(config, args) {
	const action = args.action ?? "list";
	const available = Object.keys(config.profiles ?? {});
	const describe = (name) => {
		const state = getProfileState(name);
		return {
			name,
			open: state.browser !== null || state.context !== null,
			tabs: state.pages.size,
			persistent: state.persistent,
			userDataDir: profileConfig(config, name).userDataDir ?? ""
		};
	};
	if (action === "list") return {
		current: currentProfile,
		profiles: available.map(describe)
	};
	if (action === "use") {
		const name = String(args.name ?? "");
		if (name !== "default" && !available.includes(name)) throw new Error(`unknown profile: ${name} (available: ${["default", ...available].join(", ")})`);
		setCurrentProfile(name);
		return {
			current: currentProfile,
			profiles: available.map(describe)
		};
	}
	throw new Error(`unknown profile action: ${action}`);
}
async function elementsTool(config, args) {
	const page = await getPage(config);
	const max = Math.min(Math.max(Number(args.max ?? 60) || 60, 1), 200);
	const elements = await page.evaluate((maxN) => {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		const nodes = Array.from(document.querySelectorAll("input, textarea, select, button, a[href]"));
		for (const el of nodes) {
			if (out.length >= maxN) break;
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) continue;
			const info = {
				tag: el.tagName.toLowerCase(),
				type: el.type ?? "",
				name: el.name ?? "",
				id: el.id ?? "",
				placeholder: el.placeholder ?? "",
				ariaLabel: el.getAttribute("aria-label") ?? "",
				text: (el.innerText || el.textContent || "").trim().slice(0, 80),
				href: el.href ?? "",
				selector: el.id !== "" ? `#${CSS.escape(el.id)}` : el.name !== "" ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : ""
			};
			const key = `${info.tag}|${info.name}|${info.id}|${info.placeholder}|${info.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(info);
		}
		return out;
	}, max);
	return {
		count: elements.length,
		elements
	};
}
async function closeTool() {
	await closeBrowser();
	return { closed: true };
}
//#endregion
//#region src/browser/register.ts
function registerTools(ctx, config) {
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	const timeout = (ms) => ms ?? config.timeoutMs;
	tools.register(definePlainTool({
		name: "browser_open",
		description: "在共享浏览器中打开一个 URL。之后可用 browser_snapshot 读取页面内容,用 browser_click / browser_type / browser_eval 操作页面,用 browser_screenshot 截图。",
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "要打开的完整 URL(含协议)。"
				},
				waitUntil: {
					type: "string",
					enum: [
						"load",
						"domcontentloaded",
						"commit"
					],
					description: "等待策略,默认 domcontentloaded。"
				},
				timeoutMs: {
					type: "integer",
					description: "等待超时(毫秒)。"
				}
			},
			required: ["url"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: { type: "string" },
				title: { type: "string" },
				status: { type: "string" }
			},
			required: [
				"url",
				"title",
				"status"
			]
		},
		render: (_args, value) => `Opened ${value.url}\nTitle: ${value.title}`,
		presentCall: (args) => genericCard("browser", String(args.url), String(args.url)),
		timeoutMs: timeout(),
		execute: (args) => openTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_snapshot",
		description: "读取当前页面的可访问文本、链接清单与输入框数量(不截图)。maxTextChars 默认 20000。链接列表用于构造点击选择器。",
		parameters: {
			type: "object",
			properties: {
				maxTextChars: {
					type: "integer",
					description: "文本截断上限。"
				},
				maxLinks: {
					type: "integer",
					description: "链接数量上限。"
				}
			},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: { type: "string" },
				title: { type: "string" },
				text: { type: "string" },
				truncated: { type: "boolean" },
				links: {
					type: "array",
					items: { type: "object" }
				},
				inputs: { type: "integer" }
			},
			required: [
				"url",
				"title",
				"text",
				"truncated",
				"links",
				"inputs"
			]
		},
		render: (_args, value) => `URL: ${value.url}\nTitle: ${value.title}\nInputs: ${value.inputs}\n--- text ---\n${value.text}`,
		timeoutMs: timeout(),
		execute: (args) => snapshotTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_click",
		description: "点击页面上匹配 CSS 选择器的元素(来自 browser_snapshot 的链接/表单分析)。",
		parameters: {
			type: "object",
			properties: {
				selector: {
					type: "string",
					description: "CSS 选择器。"
				},
				timeoutMs: { type: "integer" }
			},
			required: ["selector"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				clicked: { type: "string" },
				url: { type: "string" },
				title: { type: "string" }
			},
			required: [
				"clicked",
				"url",
				"title"
			]
		},
		render: (_args, value) => `Clicked ${value.clicked}\nNow at: ${value.url}`,
		timeoutMs: timeout(),
		execute: (args) => clickTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_type",
		description: "向 CSS 选择器指向的输入框输入文本。clear=true 时先清空再输入(推荐用于表单);submit=true 时输入后按回车。",
		parameters: {
			type: "object",
			properties: {
				selector: { type: "string" },
				text: { type: "string" },
				clear: { type: "boolean" },
				submit: { type: "boolean" },
				delayMs: { type: "integer" },
				timeoutMs: { type: "integer" }
			},
			required: ["selector", "text"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				typed: { type: "boolean" },
				selector: { type: "string" },
				submit: { type: "boolean" },
				url: { type: "string" },
				title: { type: "string" }
			},
			required: [
				"typed",
				"selector",
				"submit",
				"url",
				"title"
			]
		},
		render: (_args, value) => `Typed into ${value.selector}${value.submit ? " and submitted" : ""}\nNow at: ${value.url}`,
		timeoutMs: timeout(),
		execute: (args) => typeTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_press",
		description: "按键:有 selector 时先聚焦该元素再按键(如 'Enter'、'Tab'、'Escape'、'Control+a'),否则在页面级按键。",
		parameters: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description: "按键名(Playwright 键盘键名)。"
				},
				selector: { type: "string" },
				timeoutMs: { type: "integer" }
			},
			required: ["key"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				pressed: { type: "string" },
				url: { type: "string" },
				title: { type: "string" }
			},
			required: [
				"pressed",
				"url",
				"title"
			]
		},
		render: (_args, value) => `Pressed ${value.pressed}`,
		timeoutMs: timeout(),
		execute: (args) => pressTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_eval",
		description: "在页面上下文执行一段 JavaScript。表达式直接求值(如 'document.title');含换行/分号的语句会被包进 async IIFE,可用 return 返回。结果必须是可 JSON 序列化的值。",
		parameters: {
			type: "object",
			properties: { script: {
				type: "string",
				description: "要执行的 JavaScript。"
			} },
			required: ["script"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { result: {} },
			required: ["result"]
		},
		render: (_args, value) => `Result: ${JSON.stringify(value.result)}`,
		timeoutMs: timeout(),
		execute: (args) => evalTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_screenshot",
		description: "把当前页面截图保存为 PNG 文件(默认存到工作区 .dsh-reef/screenshots/),返回文件路径。纯文本模型看不到图,但用户可以在实时画面页查看。",
		parameters: {
			type: "object",
			properties: { name: {
				type: "string",
				description: "文件名(不含扩展名也会自动补 .png)。"
			} },
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				bytes: { type: "integer" },
				width: { type: "integer" },
				height: { type: "integer" }
			},
			required: [
				"path",
				"bytes",
				"width",
				"height"
			]
		},
		render: (args, value) => `Saved ${value.bytes} bytes → ${value.path}`,
		timeoutMs: timeout(),
		execute: (args, exec) => screenshotTool(config, args, exec)
	}));
	tools.register(definePlainTool({
		name: "browser_wait",
		description: "等待指定毫秒数(上限 60000),常用于等待页面渲染或请求完成。",
		parameters: {
			type: "object",
			properties: { ms: {
				type: "integer",
				description: "等待毫秒数,默认 1000。"
			} },
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				waitedMs: { type: "integer" },
				url: { type: "string" },
				title: { type: "string" }
			},
			required: [
				"waitedMs",
				"url",
				"title"
			]
		},
		render: (_args, value) => `Waited ${value.waitedMs}ms`,
		timeoutMs: timeout(),
		execute: (args) => waitTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_back",
		description: "返回上一页(如无历史则无操作)。",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: { type: "string" },
				title: { type: "string" }
			},
			required: ["url", "title"]
		},
		render: (_args, value) => `Back to: ${value.url}`,
		timeoutMs: timeout(),
		execute: () => backTool(config)
	}));
	tools.register(definePlainTool({
		name: "browser_reload",
		description: "重新加载当前页面。",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: { type: "string" },
				title: { type: "string" }
			},
			required: ["url", "title"]
		},
		render: (_args, value) => `Reloaded: ${value.url}`,
		timeoutMs: timeout(),
		execute: () => reloadTool(config)
	}));
	tools.register(definePlainTool({
		name: "browser_status",
		description: "查看浏览器会话是否打开、当前 URL 与标题。",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				open: { type: "boolean" },
				profile: { type: "string" },
				channel: { type: "string" },
				tabs: { type: "integer" },
				profiles: {
					type: "array",
					items: { type: "object" }
				},
				url: { type: "string" },
				title: { type: "string" }
			},
			required: [
				"open",
				"profile",
				"channel",
				"tabs",
				"profiles"
			]
		},
		render: (_args, value) => value.open ? `Open (${value.channel}): ${value.url} — ${value.title}` : "Not open",
		timeoutMs: timeout(),
		execute: () => statusTool()
	}));
	tools.register(definePlainTool({
		name: "browser_close",
		description: "关闭浏览器会话并释放资源;下次使用工具时会自动重新打开。",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { closed: { type: "boolean" } },
			required: ["closed"]
		},
		render: () => "Browser closed",
		execute: () => closeTool()
	}));
	tools.register(definePlainTool({
		name: "browser_tabs",
		description: "管理浏览器多标签页:list 列出所有标签,new 新建(可选带 url),switch 按 id 或 index 切换,close 关闭指定标签。id 来自 list 结果。",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"new",
						"switch",
						"close"
					]
				},
				url: {
					type: "string",
					description: "new 时打开的新标签 URL。"
				},
				id: {
					type: "integer",
					description: "目标标签 id(list 返回)。"
				},
				index: {
					type: "integer",
					description: "目标标签序号(0 起)。"
				},
				waitUntil: {
					type: "string",
					enum: [
						"load",
						"domcontentloaded",
						"commit"
					]
				},
				timeoutMs: { type: "integer" }
			},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: { type: "string" },
				tab: { type: "object" },
				tabs: {
					type: "array",
					items: { type: "object" }
				},
				activeId: { type: "integer" }
			},
			required: [
				"action",
				"tabs",
				"activeId"
			]
		},
		render: (args, value) => {
			const lines = value.tabs.map((t) => `${t.id === value.activeId ? "▶" : " "} #${t.id} ${t.url}${t.title ? ` — ${t.title}` : ""}`);
			return `tabs ${value.action}: ${lines.join("\n") || "(none)"}`;
		},
		timeoutMs: timeout(),
		execute: (args) => tabsTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_download",
		description: "获取页面上最近触发的下载(如点击下载链接后),保存到工作区 .dsh-reef/downloads/ 并返回路径。index 可选,默认最近一次;浏览器会话关闭后下载记录丢失。",
		parameters: {
			type: "object",
			properties: { index: {
				type: "integer",
				description: "下载记录序号(0 起,默认最近)。"
			} },
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				filename: { type: "string" },
				url: { type: "string" },
				bytes: { type: "integer" }
			},
			required: [
				"path",
				"filename",
				"url",
				"bytes"
			]
		},
		render: (_args, value) => `Downloaded ${value.filename} (${value.bytes} bytes) → ${value.path}`,
		timeoutMs: timeout(),
		execute: (args, exec) => downloadTool(config, args, exec)
	}));
	tools.register(definePlainTool({
		name: "browser_upload",
		description: "把本地文件上传到页面的文件输入框(selector 指向 input[type=file])。path 可以是绝对路径或相对工作区的路径。",
		parameters: {
			type: "object",
			properties: {
				selector: {
					type: "string",
					description: "文件输入框的 CSS 选择器。"
				},
				path: {
					type: "string",
					description: "要上传的文件路径。"
				},
				timeoutMs: { type: "integer" }
			},
			required: ["selector", "path"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				uploaded: { type: "string" },
				bytes: { type: "integer" },
				url: { type: "string" },
				title: { type: "string" }
			},
			required: [
				"uploaded",
				"bytes",
				"url",
				"title"
			]
		},
		render: (args, value) => `Uploaded ${value.uploaded} (${value.bytes} bytes) to ${args.selector}`,
		timeoutMs: timeout(),
		execute: (args, exec) => uploadTool(config, args, exec)
	}));
	tools.register(definePlainTool({
		name: "browser_cookies",
		description: "管理浏览器 Cookie:list 列出当前页面域名的 Cookie(默认隐藏值,showValues=true 显示),set 设置一个 Cookie(可指定 url,默认当前页面),clear 清空全部。用于处理登录态。",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"set",
						"clear"
					]
				},
				url: {
					type: "string",
					description: "list 的过滤域名或 set 的归属 URL。"
				},
				name: {
					type: "string",
					description: "set 时的 Cookie 名。"
				},
				value: {
					type: "string",
					description: "set 时的 Cookie 值。"
				},
				showValues: { type: "boolean" }
			},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				cookies: {
					type: "array",
					items: { type: "object" }
				},
				set: { type: "boolean" },
				cleared: { type: "boolean" },
				name: { type: "string" },
				url: { type: "string" }
			},
			required: []
		},
		render: (_args, value) => {
			if (value.cleared) return "All cookies cleared";
			if (value.set) return `Cookie ${value.name} set for ${value.url}`;
			return (value.cookies ?? []).map((c) => `${c.name}=${c.value} (${c.domain}${c.path}, httpOnly=${c.httpOnly})`).join("\n") || "(no cookies)";
		},
		timeoutMs: timeout(),
		execute: (args) => cookiesTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_form",
		description: "批量填充表单:fields 数组,每项给 selector(CSS)或 label(可见文本)与 value;submit=true 时填完按回车提交。也可 from=<已保存表单名> 回放(browser_form_save 保存)。先 browser_elements 或 browser_snapshot 了解表单结构。",
		parameters: {
			type: "object",
			properties: {
				fields: {
					type: "array",
					items: {
						type: "object",
						properties: {
							selector: { type: "string" },
							label: { type: "string" },
							value: { type: "string" }
						}
					},
					description: "要填充的字段列表(from 回放时省略)。"
				},
				from: {
					type: "string",
					description: "回放已保存表单的名称。"
				},
				submit: { type: "boolean" },
				timeoutMs: { type: "integer" }
			},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				filled: {
					type: "array",
					items: { type: "object" }
				},
				submit: { type: "boolean" },
				url: { type: "string" },
				title: { type: "string" }
			},
			required: [
				"filled",
				"submit",
				"url",
				"title"
			]
		},
		render: (args, value) => `Filled ${value.filled.length} field(s)${value.submit ? " and submitted" : ""}\nNow at: ${value.url}`,
		timeoutMs: timeout(),
		execute: (args) => formTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_form_save",
		description: "把最近一次 browser_form 填充的字段保存为命名表单(或直接传 fields),之后 browser_form 用 from=<name> 一键回放。",
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "表单名(回放时用)。"
				},
				fields: {
					type: "array",
					items: { type: "object" },
					description: "可选,不传则用最近一次填充。"
				}
			},
			required: ["name"],
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				saved: { type: "string" },
				fields: { type: "integer" }
			},
			required: ["saved", "fields"]
		},
		render: (_args, value) => `Saved form "${value.saved}" with ${value.fields} field(s)`,
		timeoutMs: timeout(),
		execute: (args) => formSaveTool(args)
	}));
	tools.register(definePlainTool({
		name: "browser_forms",
		description: "管理已保存的表单回放:list 列出,delete 删除指定表单。",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["list", "delete"]
				},
				name: {
					type: "string",
					description: "delete 时的表单名。"
				}
			},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				forms: {
					type: "array",
					items: { type: "object" }
				},
				deleted: { type: "boolean" },
				name: { type: "string" }
			},
			required: []
		},
		render: (args, value) => {
			if (args.action === "delete") return value.deleted ? `Deleted "${value.name}"` : `No form "${value.name}"`;
			return (value.forms ?? []).map((f) => `"${f.name}" (${f.fields} fields): ${f.preview}`).join("\n") || "(no saved forms)";
		},
		timeoutMs: timeout(),
		execute: (args) => formsTool(args)
	}));
	tools.register(definePlainTool({
		name: "browser_profile",
		description: "多浏览器配置文件:list 列出配置的 profiles(work/personal…)与当前会话状态,use <name> 切换当前 profile(后续浏览器工具作用于该 profile)。每个 profile 可配置独立 userDataDir(登录态隔离)。",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["list", "use"]
				},
				name: {
					type: "string",
					description: "use 时的 profile 名(default 或配置的)。"
				}
			},
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				current: { type: "string" },
				profiles: {
					type: "array",
					items: { type: "object" }
				}
			},
			required: ["current", "profiles"]
		},
		render: (args, value) => {
			if (args.action === "use") return `Switched to profile "${value.current}"`;
			return value.profiles.map((p) => `${p.name === value.current ? "▶" : " "} ${p.name}${p.open ? ` (open, ${p.tabs} tabs${p.persistent ? ", persistent" : ""})` : " (closed)"}${p.userDataDir ? ` → ${p.userDataDir}` : ""}`).join("\n") || "(no profiles configured)";
		},
		timeoutMs: timeout(),
		execute: (args) => profileTool(config, args)
	}));
	tools.register(definePlainTool({
		name: "browser_elements",
		description: "列出当前页面可交互元素(input/textarea/select/button/链接)的结构化清单:类型、name/id、placeholder、可见文本、可直接用于 browser_click/browser_type 的 CSS 选择器。比 browser_snapshot 更适合定位表单。",
		parameters: {
			type: "object",
			properties: { max: {
				type: "integer",
				description: "最多返回多少元素,默认 60。"
			} },
			additionalProperties: false
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				count: { type: "integer" },
				elements: {
					type: "array",
					items: { type: "object" }
				}
			},
			required: ["count", "elements"]
		},
		render: (_args, value) => (value.elements ?? []).map((e) => `<${e.tag}${e.type ? ` type=${e.type}` : ""}>${e.name ? ` name=${e.name}` : ""}${e.id ? ` id=${e.id}` : ""}${e.placeholder ? ` ph="${e.placeholder}"` : ""}${e.text ? ` "${e.text.slice(0, 40)}"` : ""}${e.selector ? ` → ${e.selector}` : ""}`).join("\n") || "(no interactive elements)",
		timeoutMs: timeout(),
		execute: (args) => elementsTool(config, args)
	}));
}
//#endregion
//#region src/browser/ui.ts
function registerBrowserApi(ctx, config) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	const base = (config.liveViewPath ?? "/reef/browser").replace(/\/+$/, "");
	const disposers = [];
	disposers.push(webServer.register({
		kind: "prefix",
		path: base,
		handler: async (req, res) => {
			const path = urlPath(req);
			if (path === `${base}/settings`) {
				await handleModuleSettings(ctx, req, res, "browser", BROWSER_SETTING_FIELDS);
				return;
			}
			if (path === `${base}/status`) {
				const state = await statusTool();
				sendJson(res, 200, state);
				return;
			}
			if (path === `${base}/history`) {
				sendJson(res, 200, {
					profile: currentProfile,
					history: [...historyOf(currentProfile)].reverse()
				});
				return;
			}
			if (path === `${base}/screenshot`) {
				const page = activePage();
				if (page === null || page.isClosed()) {
					sendText(res, 404, "browser not open");
					return;
				}
				try {
					const buffer = await page.screenshot({ type: "png" });
					res.writeHead(200, {
						"content-type": "image/png",
						"cache-control": "no-store",
						"content-length": buffer.length
					});
					res.end(buffer);
				} catch (error) {
					sendText(res, 500, `screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}
			sendText(res, 404, "not found");
		}
	}));
	ctx.effect(() => () => {
		for (const dispose of disposers) try {
			dispose();
		} catch {}
	});
}
//#endregion
//#region src/browser/index.ts
const name = "reef-browser";
const inject = ["tools"];
const BROWSER_SCHEMA = {
	enabled: {
		type: "boolean",
		optional: true
	},
	channel: { type: "string" },
	executablePath: { type: "string" },
	headless: { type: "boolean" },
	userDataDir: { type: "string" },
	profiles: { type: "any" },
	screenshotDir: { type: "string" },
	downloadDir: { type: "string" },
	screenshotMaxAgeDays: {
		type: "number",
		min: 0
	},
	screenshotMaxCount: {
		type: "number",
		min: 0
	},
	liveViewPath: { type: "string" },
	maxTextChars: {
		type: "number",
		min: 1
	},
	maxLinks: {
		type: "number",
		min: 1
	},
	timeoutMs: {
		type: "number",
		min: 1
	}
};
const DEFAULT_CONFIG = {
	channel: "auto",
	executablePath: "",
	headless: true,
	userDataDir: "",
	profiles: {},
	screenshotDir: ".dsh-reef/screenshots",
	downloadDir: ".dsh-reef/downloads",
	screenshotMaxAgeDays: 7,
	screenshotMaxCount: 200,
	liveViewPath: "/reef/browser",
	maxTextChars: 2e4,
	maxLinks: 50,
	timeoutMs: 3e4
};
/**
* 多配置文件浏览器会话。每个命名 profile(含默认 "default")独立隔离:
* 浏览器实例、标签页表、登录态(userDataDir)。插件 dispose 时全部关闭。
*/
function apply(ctx, rawConfig) {
	const resolved = resolveConfig("browser", BROWSER_SCHEMA, DEFAULT_CONFIG, rawConfig);
	if (typeof resolved.enabled === "boolean" && !resolved.enabled) return;
	if (ctx.get("tools") === void 0) return;
	const config = {
		...resolved,
		...browserOverrides()
	};
	registerTools(ctx, config);
	const sectionDispose = ctx.get("systemPrompt")?.section?.({
		name: "tool:browser",
		order: 200,
		text: "浏览器工具操作一个共享浏览器会话,支持多标签页。打开页面后先用 browser_snapshot 读文本与链接、browser_elements 读表单结构,再决定 browser_click / browser_type / browser_form;标签管理用 browser_tabs;下载用 browser_download;登录态用 browser_cookies;需要用户查看画面时用 browser_screenshot 保存截图并说明路径。"
	});
	if (sectionDispose !== void 0) ctx.effect(() => sectionDispose);
	registerBrowserApi(ctx, config);
	const sweepTimer = setInterval(() => {
		try {
			sweepScreenshotDir({
				maxAgeDays: config.screenshotMaxAgeDays,
				maxCount: config.screenshotMaxCount
			});
		} catch {}
	}, 36e5);
	sweepTimer.unref?.();
	ctx.effect(() => () => {
		clearInterval(sweepTimer);
		closeBrowser().catch(() => {});
	});
}
//#endregion
export { apply, inject, name, profileConfig };
