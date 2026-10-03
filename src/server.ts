import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { CidrError } from './core/ip.js';
import { normalizeInputs } from './core/normalize.js';
import { Store } from './db/store.js';

const PORT = Number(process.env.PORT ?? process.argv[2] ?? 0);
const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
const DB_PATH = resolve(DATA_DIR, 'cidr.sqlite');

const store = new Store(DB_PATH);

interface ApiErrorBody {
  error: { code: string; message: string };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new CidrError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, service: 'ipv4-cidr-set' });
    return;
  }

  if (method === 'GET' && path === '/sets') {
    sendJson(res, 200, { sets: store.listSets() });
    return;
  }

  if (method === 'POST' && path === '/sets/import') {
    const body = (await readBody(req)) as { name?: string; inputs?: string[] };
    if (!body.name) throw new CidrError('INVALID_NAME', '缺少 name');
    const normalized = normalizeInputs(body.inputs ?? []);
    const saved = store.importSet(body.name, normalized);
    sendJson(res, 201, { name: saved.setName, version: saved.version, result: saved.result });
    return;
  }

  const setMatch = path.match(/^\/sets\/([^/]+)$/);
  if (method === 'GET' && setMatch) {
    const name = decodeURIComponent(setMatch[1]);
    const version = url.searchParams.get('version');
    const data = version
      ? store.getVersion(name, Number(version))
      : store.getVersion(name);
    sendJson(res, 200, {
      name: data.setName,
      version: data.version,
      rawInputs: data.rawInputs,
      result: data.result,
      createdAt: data.createdAt,
    });
    return;
  }

  if (method === 'POST' && path === '/compute/intersection') {
    const body = (await readBody(req)) as {
      leftSet?: string;
      rightSet?: string;
      leftVersion?: number;
      rightVersion?: number;
    };
    assertSetArgs(body);
    const { report, result } = store.compute(
      'intersection',
      body.leftSet!,
      body.rightSet!,
      body.leftVersion,
      body.rightVersion,
    );
    sendJson(res, 200, { reportId: report.id, result });
    return;
  }

  if (method === 'POST' && path === '/compute/difference') {
    const body = (await readBody(req)) as {
      leftSet?: string;
      rightSet?: string;
      leftVersion?: number;
      rightVersion?: number;
    };
    assertSetArgs(body);
    const { report, result } = store.compute(
      'difference',
      body.leftSet!,
      body.rightSet!,
      body.leftVersion,
      body.rightVersion,
    );
    sendJson(res, 200, { reportId: report.id, result });
    return;
  }

  const memberMatch = path.match(/^\/sets\/([^/]+)\/membership$/);
  if (method === 'GET' && memberMatch) {
    const name = decodeURIComponent(memberMatch[1]);
    const address = url.searchParams.get('address');
    if (!address) throw new CidrError('MISSING_ADDRESS', '缺少 address 查询参数');
    const versionParam = url.searchParams.get('version');
    const result = store.membership(name, address, versionParam ? Number(versionParam) : undefined);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'GET' && path === '/reports') {
    sendJson(res, 200, { reports: store.listReports() });
    return;
  }

  const reportMatch = path.match(/^\/reports\/(\d+)$/);
  if (method === 'GET' && reportMatch) {
    sendJson(res, 200, store.getReport(Number(reportMatch[1])));
    return;
  }

  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `未知路径 ${method} ${path}` } });
}

function assertSetArgs(body: { leftSet?: string; rightSet?: string }): void {
  if (!body.leftSet || !body.rightSet) {
    throw new CidrError('MISSING_SET', '必须提供 leftSet 与 rightSet');
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (error instanceof CidrError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
      sendJson(res, error.code === 'SET_NOT_FOUND' || error.code === 'REPORT_NOT_FOUND' ? 404 : 400, body);
    } else {
      sendJson(res, 500, {
        error: { code: 'INTERNAL_ERROR', message: (error as Error).message },
      });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : PORT;
  console.log(JSON.stringify({
    msg: 'IPv4 CIDR 集合服务已启动',
    baseUrl: `http://127.0.0.1:${actual}`,
    port: actual,
    database: DB_PATH,
  }, null, 2));
});

const shutdown = (): void => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
