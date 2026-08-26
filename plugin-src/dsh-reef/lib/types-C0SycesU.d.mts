//#region src/lib/types.d.ts
/** 最小 Cordis 上下文(我们只消费这几个成员)。 */
interface ReefContext {
  get<T = any>(name: string): T | undefined;
  effect(fn: () => (() => void) | void, label?: string): void;
  on?(event: string, listener: (...args: unknown[]) => unknown): (() => void) | void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  tools?: {
    register(definition: PlainToolDefinition): unknown;
  };
  systemPrompt?: {
    section(section: {
      name: string;
      order?: number;
      text: string;
    }): () => void;
  };
}
/** 工具执行上下文(ToolRunContext 的我们用到的最小面)。 */
interface ToolRunContext {
  signal: AbortSignal;
  agent?: {
    session?: {
      meta?: {
        cwd?: string;
      };
    };
  };
  callId?: string;
}
/** 规范化工具输出契约。 */
interface PlainToolOutput {
  schema: Record<string, unknown>;
  render: (args: unknown, value: unknown) => {
    type: "text";
    text: string;
  }[];
}
/** 注册到 ctx.tools 的规范化工具定义。 */
interface PlainToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: PlainToolOutput;
  execute: (args: any, exec: ToolRunContext) => Promise<unknown> | unknown;
  presentCall?: (args: any) => unknown;
  isConcurrencySafe?: () => boolean;
  timeoutMs?: number;
}
//#endregion
export { ReefContext as t };