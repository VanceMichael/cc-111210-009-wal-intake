import { createServer } from 'node:http';

export async function listen(handler, port = 0) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const result = await handler(url, request);
      const status = result.status ?? 200;
      const headers = { 'content-type': result.type ?? 'application/json; charset=utf-8', ...result.headers };
      response.writeHead(status, headers);
      response.end(Buffer.isBuffer(result.body) || typeof result.body === 'string'
        ? result.body : JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}

export async function get(base, path) {
  const url = new URL(path, base);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('演练源只允许本地地址');
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`来源返回 ${response.status}`);
  return response;
}
