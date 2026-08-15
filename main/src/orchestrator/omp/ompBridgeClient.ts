/**
 * Minimal MCP-over-HTTP client for the OMP Prime bridge.
 *
 * Speaks JSON-RPC 2.0 to the bridge's streamable-HTTP MCP endpoint
 * (`POST /mcp/v1/sessions/<sessionId>`) with a bearer token. Only what the
 * command adapter needs — `tools/call` — is implemented; `tools/list` and the
 * initialize handshake are out of scope (the bridge accepts `tools/call`
 * without a prior initialize, and the command surface calls tools by exact
 * name, never by discovery).
 *
 * Standalone-typecheck invariant: no imports from electron, better-sqlite3, or
 * services/*. `fetch` is Node 22 global; this module is pure.
 */

/** A tool invocation, as the bridge's MCP endpoint expects it. */
export interface OmpBridgeToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** The useful slice of an MCP `tools/call` result. */
export type OmpBridgeCallResult =
  | { readonly ok: true; readonly text: string; readonly structuredContent?: unknown }
  | { readonly ok: false; readonly isError: boolean; readonly text: string; readonly structuredContent?: unknown };

/** Narrow client seam so the command adapter is testable without a live bridge. */
export interface OmpBridgeClientLike {
  callTool(call: OmpBridgeToolCall): Promise<OmpBridgeCallResult>;
}

/** Wire shape of the bridge MCP `tools/call` response. */
interface McpCallResponse {
  jsonrpc: "2.0";
  id?: unknown;
  result?: {
    content?: Array<{ type: "text"; text: string } | { type: "image" }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

export class OmpBridgeHttpClient implements OmpBridgeClientLike {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly sessionId: string,
  ) {}

  async callTool(call: OmpBridgeToolCall): Promise<OmpBridgeCallResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/mcp/v1/sessions/${encodeURIComponent(this.sessionId)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: call.name, arguments: call.arguments },
        }),
      });
    } catch (error) {
      return {
        ok: false,
        isError: true,
        text: `bridge unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let body: McpCallResponse;
    try {
      body = (await response.json()) as McpCallResponse;
    } catch {
      return { ok: false, isError: true, text: `bridge returned non-JSON (HTTP ${response.status})` };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        isError: true,
        text: `bridge rejected the credential (HTTP ${response.status})`,
      };
    }

    if (body.error !== undefined) {
      return { ok: false, isError: true, text: body.error.message };
    }

    const result = body.result;
    const text = (result?.content ?? [])
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const isError = result?.isError === true;
    return {
      ok: !isError,
      isError,
      text,
      structuredContent: result?.structuredContent,
    };
  }
}
