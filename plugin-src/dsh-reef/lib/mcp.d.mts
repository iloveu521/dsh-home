import { t as ReefContext } from "./types-C0SycesU.mjs";
//#region src/mcp/types.d.ts
/** MCP 模块配置。 */
interface McpConfig {
  enabled?: boolean;
  path?: string;
  authTokenEnv?: string;
  oauthEnabled?: boolean;
  oauthClientIdEnv?: string;
  oauthClientSecretEnv?: string;
  oauthTokenTtlMs?: number;
  oauthTokenPath?: string;
  runAgentTimeoutMs?: number;
  runAgentMaxOutputChars?: number;
  listSessionsLimit?: number;
}
//#endregion
//#region src/mcp/sessions.d.ts
declare function summarize(events: any[], firstSeq: number): {
  text: string;
  reason: any;
};
declare function truncate(text: string, maxChars: number): string;
/** 事件 → 一行摘要(防御性投影,任何字段缺失都不抛错)。 */
declare function projectEvent(event: Record<string, any>, maxChars?: number): {
  seq: any;
  type: any;
} | {
  text: string;
  seq: any;
  type: any;
} | {
  name: any;
  args: string;
  seq: any;
  type: any;
} | {
  error: boolean;
  seq: any;
  type: any;
} | {
  reason: any;
  seq: any;
  type: any;
};
//#endregion
//#region src/mcp/protocol.d.ts
declare function rpcError(id: any, code: number, message: string): {
  jsonrpc: string;
  id: any;
  error: {
    code: number;
    message: string;
  };
};
declare function rpcResult(id: any, result: unknown): {
  jsonrpc: string;
  id: any;
  result: unknown;
};
//#endregion
//#region src/mcp/tools.d.ts
declare const MCP_TOOLS: ({
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: {
      limit: {
        type: string;
        description: string;
      };
      sessionId?: undefined;
      maxEvents?: undefined;
      query?: undefined;
      prompt?: undefined;
      cwd?: undefined;
      provider?: undefined;
      model?: undefined;
      timeoutMs?: undefined;
    };
    required?: undefined;
    additionalProperties?: undefined;
  };
} | {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: {
      sessionId: {
        type: string;
        description: string;
      };
      maxEvents: {
        type: string;
        description: string;
      };
      limit?: undefined;
      query?: undefined;
      prompt?: undefined;
      cwd?: undefined;
      provider?: undefined;
      model?: undefined;
      timeoutMs?: undefined;
    };
    required: string[];
    additionalProperties?: undefined;
  };
} | {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: {
      query: {
        type: string;
      };
      limit: {
        type: string;
        description?: undefined;
      };
      sessionId?: undefined;
      maxEvents?: undefined;
      prompt?: undefined;
      cwd?: undefined;
      provider?: undefined;
      model?: undefined;
      timeoutMs?: undefined;
    };
    required: string[];
    additionalProperties?: undefined;
  };
} | {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: {
      prompt: {
        type: string;
        description: string;
      };
      cwd: {
        type: string;
        description: string;
      };
      provider: {
        type: string;
        description: string;
      };
      model: {
        type: string;
        description: string;
      };
      timeoutMs: {
        type: string;
        description: string;
      };
      limit?: undefined;
      sessionId?: undefined;
      maxEvents?: undefined;
      query?: undefined;
    };
    required: string[];
    additionalProperties?: undefined;
  };
} | {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: {
      limit?: undefined;
      sessionId?: undefined;
      maxEvents?: undefined;
      query?: undefined;
      prompt?: undefined;
      cwd?: undefined;
      provider?: undefined;
      model?: undefined;
      timeoutMs?: undefined;
    };
    additionalProperties: boolean;
    required?: undefined;
  };
})[];
/** 汇总一次 agent 运行:提取最新 assistant 文本与结束原因(参照官方 headless 驱动)。 */
//#endregion
//#region src/mcp/index.d.ts
declare const name = "reef-mcp";
declare const inject: string[];
declare function apply(ctx: ReefContext, rawConfig: Record<string, any>): void;
//#endregion
export { MCP_TOOLS, type McpConfig, apply, inject, name, projectEvent, rpcError, rpcResult, summarize, truncate };