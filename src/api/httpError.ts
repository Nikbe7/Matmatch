// The one error shape every route and the error middleware agree on. A route or
// middleware that wants a specific status/code throws this; anything else (a driver
// error, an unexpected exception) is treated as unknown and mapped to a generic 500
// by the error middleware — never forwarded to the client as-is.

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
