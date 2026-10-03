import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Service, SetRef } from "./service";
import { CidrError } from "./ipv4";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text + "\n");
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof CidrError) {
    sendJson(res, 400, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CidrError("BAD_JSON", "请求体不是合法 JSON");
  }
}

function asSetRef(v: unknown, field: string): SetRef {
  const o = v as SetRef;
  if (!o || typeof o.set !== "string") {
    throw new CidrError("INVALID_REF", `字段 "${field}" 需要 { "set": 名称, "version": 可选 }`);
  }
  if (o.version !== undefined && (!Number.isInteger(o.version) || o.version < 1)) {
    throw new CidrError("INVALID_REF", `字段 "${field}.version" 必须是正整数`);
  }
  return o;
}

function asItems(v: unknown): string[] {
  if (!Array.isArray(v)) throw new CidrError("INVALID_ITEMS", "字段 \"items\" 必须是字符串数组");
  return v as string[];
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : ({} as Record<string, unknown>);
      const b = body as Record<string, unknown>;

      if (method === "GET" && path === "/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && path === "/sets") {
        if (typeof b.name !== "string") throw new CidrError("INVALID_NAME", "字段 \"name\" 必填");
        return sendJson(res, 201, service.importSet(b.name, asItems(b.items)));
      }
      if (method === "GET" && path === "/sets") {
        return sendJson(res, 200, { sets: service.store.listSets() });
      }
      let m = path.match(/^\/sets\/([^/]+)$/);
      if (method === "GET" && m) {
        return sendJson(res, 200, { set: m[1], versions: service.store.listVersions(m[1]) });
      }
      m = path.match(/^\/sets\/([^/]+)\/versions$/);
      if (method === "POST" && m) {
        return sendJson(res, 201, service.importSet(m[1], asItems(b.items)));
      }
      m = path.match(/^\/sets\/([^/]+)\/versions\/(\d+)$/);
      if (method === "GET" && m) {
        return sendJson(res, 200, service.store.getVersion(m[1], Number(m[2])));
      }
      if (method === "POST" && path === "/compute/merge") {
        return sendJson(res, 200, service.merge(asSetRef(b, "body")));
      }
      if (method === "POST" && path === "/compute/intersect") {
        return sendJson(res, 200, service.intersect(asSetRef(b.a, "a"), asSetRef(b.b, "b")));
      }
      if (method === "POST" && path === "/compute/subtract") {
        return sendJson(res, 200, service.subtract(asSetRef(b.a, "a"), asSetRef(b.b, "b")));
      }
      if (method === "POST" && path === "/query/membership") {
        if (typeof b.ip !== "string") throw new CidrError("INVALID_QUERY", "字段 \"ip\" 必填");
        if (b.report !== undefined) {
          return sendJson(res, 200, service.membershipByReport(b.ip, Number(b.report)));
        }
        return sendJson(res, 200, service.membership(b.ip, asSetRef(b, "body")));
      }
      if (method === "GET" && path === "/reports") {
        return sendJson(res, 200, { reports: service.store.listReports() });
      }
      m = path.match(/^\/reports\/(\d+)$/);
      if (method === "GET" && m) {
        return sendJson(res, 200, service.store.getReport(Number(m[1])));
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `${method} ${path} 不存在` } });
    } catch (err) {
      return sendError(res, err);
    }
  });
}

export function startServer(service: Service, port: number): Promise<number> {
  const server = createServer(service);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
