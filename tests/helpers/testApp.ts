import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { TEST_PASSWORD, assertTestDatabase } from "./testDb.js";

export interface TestResponse {
  status: number;
  body: any;
}

export type TestClient = ReturnType<Awaited<ReturnType<typeof startTestApp>>["client"]>;

// starts the real Express app on a free local port
export async function startTestApp() {
  // imported here so testDb has already pointed DATABASE_URL at the test database
  const { app } = await import("../../src/app.js");
  const { pool } = await import("../../src/lib/db.js");
  // stop before the server starts if the app's pool points anywhere else
  assertTestDatabase((pool as unknown as { options: { connectionString?: string } }).options.connectionString);
  // a local test URL, so it doesn't need to come from .env
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function request(method: string, path: string, cookie?: string, body?: unknown) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep responses that aren't JSON as text
    }
    return { status: res.status, body: parsed, cookie: res.headers.getSetCookie()[0]?.split(";")[0] };
  }

  // requests sent with one session cookie (or none)
  function client(cookie?: string) {
    return {
      cookie,
      get: (path: string): Promise<TestResponse> => request("GET", path, cookie),
      post: (path: string, body?: unknown): Promise<TestResponse> => request("POST", path, cookie, body),
      put: (path: string, body?: unknown): Promise<TestResponse> => request("PUT", path, cookie, body),
      patch: (path: string, body?: unknown): Promise<TestResponse> => request("PATCH", path, cookie, body),
      delete: (path: string): Promise<TestResponse> => request("DELETE", path, cookie),
    };
  }

  async function login(path: string, body: object) {
    const res = await request("POST", path, undefined, body);
    if (res.status !== 200 || !res.cookie) throw new Error(`Test login failed (${path}): ${res.status}`);
    return client(res.cookie);
  }

  return {
    db: pool,
    baseUrl,
    client,
    loginStaff: (employeeId: number, password = TEST_PASSWORD) => login("/api/auth/staff/login", { employeeId, password }),
    loginPatient: (patientId: number, email: string) => login("/api/auth/patient/login", { patientId, email, password: TEST_PASSWORD }),
    staffLoginStatus: async (employeeId: number, password = TEST_PASSWORD) =>
      (await request("POST", "/api/auth/staff/login", undefined, { employeeId, password })).status,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}
