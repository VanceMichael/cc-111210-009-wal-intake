import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  return listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
