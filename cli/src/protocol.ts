/**
 * Wire protocol types shared between CLI bridge and Chrome extension.
 * All messages flow over the WebSocket connection.
 */

/** A tool schema as advertised by the extension */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Extension → CLI: register available tools */
export interface RegisterToolsMessage {
  type: "register_tools";
  tools: ToolSchema[];
}

/** CLI → Extension: request tool execution */
export interface ExecuteToolMessage {
  type: "execute_tool";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Extension → CLI: return tool execution result */
export interface ToolResultMessage {
  type: "tool_result";
  callId: string;
  result?: unknown;
  error?: string;
  isError?: boolean;
}

/** Discriminated union of all wire messages */
export type WireMessage =
  | RegisterToolsMessage
  | ExecuteToolMessage
  | ToolResultMessage;

/** Type guard for RegisterToolsMessage */
export function isRegisterTools(msg: unknown): msg is RegisterToolsMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "register_tools"
  );
}

/** Type guard for ExecuteToolMessage */
export function isExecuteTool(msg: unknown): msg is ExecuteToolMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "execute_tool"
  );
}

/** Type guard for ToolResultMessage */
export function isToolResult(msg: unknown): msg is ToolResultMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "tool_result"
  );
}
