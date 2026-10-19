import { callOpenAI } from '../lib/provider.mjs';

// Keep the frozen request/settings/pricing parser. Bound the response as well
// as the request, and never retry a transport error or follow a redirect.
export function callProvider(args, fetchImpl = fetch) {
  return callOpenAI({
    ...args,
    fetchImpl: async (url, options) => {
      const response = await fetchImpl(url, options);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing provider response.');
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 524288) throw new Error('Provider response exceeded limit.');
          chunks.push(Buffer.from(value));
        }
        return new Response(Buffer.concat(chunks), { status: response.status });
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  });
}
