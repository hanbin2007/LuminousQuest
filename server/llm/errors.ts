export class ProviderHttpError extends Error {
  constructor(
    readonly providerId: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${providerId} returned HTTP ${status}: ${detail}`);
    this.name = 'ProviderHttpError';
  }
}

export class StructuredResponseValidationError extends Error {
  readonly retryable: boolean;
  readonly category: string;

  constructor(
    message: string,
    options: { retryable?: boolean; category?: string } = {},
  ) {
    super(message);
    this.name = 'StructuredResponseValidationError';
    this.retryable = options.retryable ?? true;
    this.category = options.category ?? 'schema-invalid';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Provider call exceeded ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

export class UnsupportedCapabilityError extends Error {
  constructor(
    readonly providerId: string,
    readonly capability: 'vision',
  ) {
    super(`${providerId} does not support ${capability} input`);
    this.name = 'UnsupportedCapabilityError';
  }
}
