import { t as ReefContext } from "./types-C0SycesU.mjs";
//#region src/github/types.d.ts
/** GitHub 模块配置。 */
interface GithubConfig {
  enabled?: boolean;
  tokenEnv?: string;
  apiBase?: string;
  webhookPath?: string;
  webhookSecretEnv?: string;
  reviewModel?: Record<string, any>;
  reviewMaxDiffChars?: number;
  autoReviewEvents?: string[];
  reviewDedupe?: boolean;
  autoFixRepos?: Record<string, string>;
  autoFixLabels?: string[];
  autoFixTimeoutMs?: number;
}
//#endregion
//#region src/github/webhook.d.ts
declare function verifySignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean;
declare function extractPrRef(payload: Record<string, any>): Record<string, any> | undefined;
//#endregion
//#region src/github/autofix.d.ts
declare function extractIssueRef(payload: Record<string, any>): Record<string, any> | undefined;
//#endregion
//#region src/github/review.d.ts
declare function buildReviewPrompt(pr: Record<string, any>, files: Record<string, any>[]): string;
//#endregion
//#region src/github/api.d.ts
/** "owner/repo" → URL 编码的 project id(owner%2Frepo)。 */
declare function encodeProject(project: string): string;
declare function projectIssue(issue: Record<string, any>): {
  number: any;
  title: any;
  state: any;
  user: any;
  labels: any;
  comments: any;
  created_at: any;
  html_url: any;
};
declare function projectPr(pr: Record<string, any>): {
  number: any;
  title: any;
  state: any;
  draft: boolean;
  merged: boolean;
  user: any;
  head: any;
  base: any;
  additions: any;
  deletions: any;
  changed_files: any;
  created_at: any;
  html_url: any;
};
//#endregion
//#region src/github/index.d.ts
declare const name = "reef-github";
declare const inject: string[];
declare function apply(ctx: ReefContext, rawConfig: Record<string, any>): void;
//#endregion
export { type GithubConfig, apply, buildReviewPrompt, encodeProject, extractIssueRef, extractPrRef, inject, name, projectIssue, projectPr, verifySignature };