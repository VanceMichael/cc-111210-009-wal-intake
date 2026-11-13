import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';
import { Intake } from './intake.mjs';
import { MANIFEST_NAME, MAIN_NAME, WAL_NAME } from './manifest.mjs';

// 从演练来源抓取三份交付字节（manifest/main/wal），来源协议与 docs/source-contract.md 对齐。
async function fetchDelivery(source, { walPath = '/' + WAL_NAME } = {}) {
  const manifestResponse = await fetch(new URL('/manifest', source));
  if (!manifestResponse.ok) throw new Error(`来源 manifest 返回 ${manifestResponse.status}`);
  const manifest = Buffer.from(await manifestResponse.arrayBuffer());
  const manifestJson = JSON.parse(manifest.toString('utf8'));
  const files = new Map();
  for (const declaration of manifestJson.files) {
    const response = await fetch(new URL('/' + declaration.name, source));
    if (!response.ok) throw new Error(`来源文件 ${declaration.name} 返回 ${response.status}`);
    files.set(declaration.name, Buffer.from(await response.arrayBuffer()));
  }
  if (walPath !== '/' + WAL_NAME) {
    const response = await fetch(new URL(walPath, source));
    if (!response.ok) throw new Error(`来源 WAL 变体返回 ${response.status}`);
    files.set(WAL_NAME, Buffer.from(await response.arrayBuffer()));
  }
  return [[MANIFEST_NAME, manifest], ...files];
}

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  const intake = new Intake({ directory });
  await intake.prepare();
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

    // 离线接收：从来源抓取三份交付字节并执行完整接收流水线。
    if (url.pathname === '/offline/intake') {
      const walPath = url.searchParams.get('walVariant') ? '/' + url.searchParams.get('walVariant') : undefined;
      const delivery = await fetchDelivery(source, walPath ? { walPath } : {});
      try {
        const result = await intake.receive(delivery);
        return { body: { ok: true, duplicated: result.duplicated, receipt: result.receipt } };
      } catch (error) {
        return { status: 422, body: { ok: false, error: error.message, code: error.code ?? null, evidence: error.evidence ?? null } };
      }
    }
    if (url.pathname === '/offline/current') {
      const current = await intake.current();
      if (!current) return { status: 404, body: { ok: false, error: '尚无已发布的接收版本' } };
      return { body: current };
    }
    if (url.pathname === '/offline/rows') {
      try {
        return { body: { rows: await intake.queryCurrent() } };
      } catch (error) {
        return { status: 404, body: { ok: false, error: error.message } };
      }
    }
    if (url.pathname === '/offline/evidence') return { body: await intake.evidence() };
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
