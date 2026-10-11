export class GatewayError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
