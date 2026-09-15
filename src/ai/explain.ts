import { ProviderError } from './provider';

/** One sentence per thing that can go wrong, in the writer's terms. */
export function explainProviderError(e: unknown): string {
  if (e instanceof ProviderError) {
    switch (e.code) {
      case 'auth': return 'OpenRouter rejected this key.';
      case 'credit': return 'This OpenRouter account has no credit left.';
      case 'rate-limit': return 'OpenRouter is rate-limiting requests. Try again in a moment.';
      case 'refused': return `The provider declined: ${e.message}`;
      case 'bad-request': return `OpenRouter rejected the request: ${e.message}`;
      case 'provider': return `OpenRouter had a problem at its end: ${e.message}`;
      case 'network':
        return 'No answer from OpenRouter — the device is offline, or the browser was not allowed to make the call.';
    }
  }
  return (e as Error)?.message ?? String(e);
}
