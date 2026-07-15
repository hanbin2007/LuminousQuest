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
  constructor(message: string) {
    super(message);
    this.name = 'StructuredResponseValidationError';
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
