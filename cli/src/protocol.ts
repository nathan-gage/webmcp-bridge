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

/** Extension → CLI: lightweight hint that tool list changed (no payload) */
export interface ToolsChangedMessage {
  type: "tools_changed";
}

/** CLI → Extension: request current tool list */
export interface GetToolsMessage {
  type: "get_tools";
  requestId: string;
}

/** Extension → CLI: response with current tool list */
export interface ToolsListMessage {
  type: "tools_list";
  requestId: string;
  tools: ToolSchema[];
}

/** Extension → CLI: register available tools (legacy, kept for backward compat) */
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
  | ToolsChangedMessage
  | GetToolsMessage
  | ToolsListMessage
  | RegisterToolsMessage
  | ExecuteToolMessage
  | ToolResultMessage;

/** Type guard for ToolsChangedMessage */
export function isToolsChanged(msg: unknown): msg is ToolsChangedMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "tools_changed"
  );
}

/** Type guard for ToolsListMessage */
export function isToolsList(msg: unknown): msg is ToolsListMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "tools_list"
  );
}

/** Type guard for RegisterToolsMessage (legacy) */
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
