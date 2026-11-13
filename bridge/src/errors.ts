export type BridgeErrorCode =
  | "INVALID_URL"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "POST_INACCESSIBLE"
  | "NO_RECIPE"
  | "INCOMPLETE_RECIPE"
  | "EXTRACTOR_UNAVAILABLE"
  | "MODEL_TIMEOUT"
  | "MODEL_ERROR"
  | "INVALID_MODEL_OUTPUT"
  | "INTERNAL";

const STATUS_BY_CODE: Record<BridgeErrorCode, number> = {
  INVALID_URL: 400,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  POST_INACCESSIBLE: 422,
  NO_RECIPE: 422,
  INCOMPLETE_RECIPE: 502,
  EXTRACTOR_UNAVAILABLE: 503,
  MODEL_TIMEOUT: 504,
  MODEL_ERROR: 502,
  INVALID_MODEL_OUTPUT: 502,
  INTERNAL: 500,
};

const RETRYABLE_BY_CODE: Record<BridgeErrorCode, boolean> = {
  INVALID_URL: false,
  UNAUTHORIZED: false,
  RATE_LIMITED: false,
  BAD_REQUEST: false,
  NOT_FOUND: false,
  METHOD_NOT_ALLOWED: false,
  POST_INACCESSIBLE: false,
  NO_RECIPE: false,
  INCOMPLETE_RECIPE: true,
  EXTRACTOR_UNAVAILABLE: true,
  MODEL_TIMEOUT: false,
  MODEL_ERROR: true,
  INVALID_MODEL_OUTPUT: true,
  INTERNAL: false,
};

export interface BridgeErrorOptions {
  retryable?: boolean;
  cause?: unknown;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: BridgeErrorCode, message: string, options: BridgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BridgeError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? RETRYABLE_BY_CODE[code];
  }
}

export interface BridgeErrorPayload {
  error: {
    code: BridgeErrorCode;
    message: string;
    retryable: boolean;
  };
}

export function errorPayload(error: BridgeError): BridgeErrorPayload {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
}
