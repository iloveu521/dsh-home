import { t as ReefContext } from "./types-C0SycesU.mjs";
//#region src/gitlab/types.d.ts
/** GitLab 模块配置。 */
interface GitlabConfig {
  enabled?: boolean;
  tokenEnv?: string;
  apiBase?: string;
  webhookPath?: string;
  webhookSecretEnv?: string;
  reviewModel?: Record<string, any>;
  reviewMaxDiffChars?: number;
  autoReviewEvents?: string[];
}
//#endregion
//#region src/gitlab/webhook.d.ts
declare function verifyToken(rawBody: string, headerToken: string | undefined, secret: string): boolean;
declare function extractMrRef(payload: Record<string, any>): Record<string, any> | undefined;
//#endregion
//#region src/gitlab/api.d.ts
declare function encodeProject(project: string): string;
declare function projectIssue(issue: Record<string, any>): {
  iid: any;
  title: any;
  state: any;
  user: any;
  labels: any;
  created_at: any;
  web_url: any;
};
declare function projectMr(mr: Record<string, any>): {
  iid: any;
  title: any;
  state: any;
  user: any;
  source_branch: any;
  target_branch: any;
  merged_at: any;
  web_url: any;
};
//#endregion
//#region src/gitlab/index.d.ts
declare const name = "reef-gitlab";
declare const inject: string[];
declare function apply(ctx: ReefContext, rawConfig: Record<string, any>): void;
//#endregion
export { type GitlabConfig, apply, encodeProject, extractMrRef, inject, name, projectIssue, projectMr, verifyToken };