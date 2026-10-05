export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly type: string = "invalid_request_error"
  ) {
    super(message);
    this.name = "ProxyError";
  }
}
