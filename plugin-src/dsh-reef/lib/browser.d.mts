import { t as ReefContext } from "./types-C0SycesU.mjs";
import "playwright-core";
//#region src/browser/types.d.ts
interface BrowserConfig {
  enabled?: boolean;
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  userDataDir?: string;
  profiles?: Record<string, Partial<BrowserConfig>>;
  screenshotDir?: string;
  downloadDir?: string;
  /** 截图保留天数(0 = 不按时间清理)。 */
  screenshotMaxAgeDays?: number;
  /** 截图保留数量上限(0 = 不按数量清理)。 */
  screenshotMaxCount?: number;
  liveViewPath?: string;
  maxTextChars?: number;
  maxLinks?: number;
  timeoutMs?: number;
}
//#endregion
//#region src/browser/session.d.ts
declare function profileConfig(config: BrowserConfig, name: string): BrowserConfig;
//#endregion
//#region src/browser/index.d.ts
declare const name = "reef-browser";
declare const inject: string[];
/**
 * 多配置文件浏览器会话。每个命名 profile(含默认 "default")独立隔离:
 * 浏览器实例、标签页表、登录态(userDataDir)。插件 dispose 时全部关闭。
 */
declare function apply(ctx: ReefContext, rawConfig: Record<string, any>): void;
//#endregion
export { type BrowserConfig, apply, inject, name, profileConfig };