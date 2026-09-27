export class BenchmarkError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Never serialize provider errors, request headers/bodies, or exception messages.
export function publicError(error) {
  return error instanceof BenchmarkError
    ? { code: error.code, message: error.message }
    : { code: 'provider_error', message: 'The benchmark could not finish. Check your connection and try again.' };
}

export function providerError(status, code) {
  if (status === 401) return new BenchmarkError('invalid_key', 'OpenAI did not accept that API key. Check it and try again.', 401);
  if (status === 403 || status === 404 || code === 'model_not_found') return new BenchmarkError('model_unavailable', 'This model is unavailable to your API key. Check model access in your OpenAI project.', 403);
  if (code === 'context_length_exceeded') return new BenchmarkError('context_too_long', 'This request is too long. Try a smaller representative example.');
  if (code === 'insufficient_quota') return new BenchmarkError('quota', 'Your OpenAI project has no available API credit. Check its billing or spending limit.', 429);
  if (status === 429) return new BenchmarkError('rate_limit', 'OpenAI is limiting requests. Wait a moment before running a new benchmark.', 429);
  return new BenchmarkError('provider_error', 'OpenAI could not complete this call. You can try a new benchmark later.', 502);
}
