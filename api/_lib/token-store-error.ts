import { apiError } from "./http.js";

export type TokenStoreOperation = "list" | "create" | "revoke";

export interface TokenStoreFailureDetails {
  readonly status: number;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

export interface SafeTokenStoreError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

const OPERATION_FAILURES: Readonly<Record<TokenStoreOperation, SafeTokenStoreError>> = {
  list: { status: 502, code: "TOKEN_LIST_FAILED", message: "Active tokens could not be listed." },
  create: { status: 502, code: "TOKEN_CREATE_FAILED", message: "The token could not be created." },
  revoke: { status: 502, code: "TOKEN_REVOKE_FAILED", message: "The token could not be revoked." }
};

export function classifyTokenStoreFailure(operation: TokenStoreOperation, failure: TokenStoreFailureDetails): SafeTokenStoreError {
  if (failure.code === "P0001" && failure.message?.includes("active MCP token limit")) {
    return { status: 409, code: "TOKEN_LIMIT", message: "Revoke an existing token before creating another. The maximum is five active tokens." };
  }
  if (failure.code === "42501") {
    return {
      status: 503,
      code: "TOKEN_STORE_PERMISSION",
      message: "Token storage is unavailable because the server database role is missing required permissions. An administrator must apply the latest Supabase migration."
    };
  }
  if (failure.code === "42P01" || failure.code === "PGRST205") {
    return {
      status: 503,
      code: "TOKEN_STORE_MIGRATION",
      message: "Token storage has not been provisioned. An administrator must apply the latest Supabase migration."
    };
  }
  if (failure.status === 401 || failure.status === 403) {
    return {
      status: 503,
      code: "TOKEN_STORE_ACCESS",
      message: "Token storage could not be reached with the server credential. An administrator must verify the Supabase server key and latest migration."
    };
  }
  return OPERATION_FAILURES[operation];
}

export async function tokenStoreErrorResponse(response: Response, operation: TokenStoreOperation): Promise<Response> {
  const text = await response.text().catch(() => "");
  const value = parseFailureBody(text);
  const safeError = classifyTokenStoreFailure(operation, {
    status: response.status,
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : undefined
  });
  return apiError(safeError.status, safeError.code, safeError.message);
}

function parseFailureBody(text: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
