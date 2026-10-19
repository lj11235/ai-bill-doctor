import { callOpenAI } from '../lib/provider.mjs';

// Explicit localhost demo/test only. No network requests and no real credentials.
export function fakeProvider({ delayMs = 100 } = {}) {
  return (args) =>
    callOpenAI({
      ...args,
      apiKey: 'demo-placeholder-not-a-credential',
      fetchImpl: async (_url, options) => {
        if (delayMs)
          await new Promise((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(new Error('Demo cancelled'));
            };
            const timer = setTimeout(() => {
              options.signal.removeEventListener('abort', abort);
              resolve();
            }, delayMs);
            options.signal.addEventListener('abort', abort, { once: true });
            if (options.signal.aborted) abort();
          });
        const payload = JSON.parse(options.body);
        const input = Math.max(30, Math.ceil(Buffer.byteLength(JSON.stringify(payload.input)) / 4));
        const output =
          payload.model === 'gpt-6-astra' ? 150 : payload.model === 'gpt-6.1-sol' ? 130 : 110;
        return new Response(
          JSON.stringify({
            ...payload,
            status: 'completed',
            usage: {
              input_tokens: input,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: output,
              output_tokens_details: { reasoning_tokens: 20 },
              total_tokens: input + output,
            },
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'LOCAL DEMO — simulated output, not a real model result.\n\nPrioritize the reliability issue before adding features. Investigate the disconnects, acknowledge the missed meeting, and give the customer a clear next update.\n\nThis sample exists only to test the review and savings flow.',
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
}
