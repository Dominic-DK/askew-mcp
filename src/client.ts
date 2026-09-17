export type Envelope = { v: 1; enc: string; ct: string };
export type Route = { routeId: string; name: string; shortcutName: string; executionMode: "auto" | "confirm"; dataKinds: string[]; deviceId: string; enabled: boolean; lastSuccessAt: string | null; createdAt: string };
export type SelfInfo = { connectorId: string; name: string; fingerprint: string | null; mode: "e2e" | "server"; devices: { deviceId: string; publicKey: string; fingerprint: string; name: string | null; lastSeenAt: string | null }[]; routes: Route[] };
export type JobView = { jobId: string; status: string; routeId: string; createdAt: string; result?: Envelope; error?: string; note?: string; timeline: { step: string; at: string; by: string; note?: string }[] };
export type InboxItem = { id: string; deviceId: string; payload: Envelope; ref: string | null; kind: string; createdAt: string };

export class AskewApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export class AskewClient {
  constructor(private base: string, private key: string) { this.base = base.replace(/\/+$/, ""); }
  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method, headers: { authorization: `Bearer ${this.key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new AskewApiError(res.status, data?.error?.code ?? "HTTP_" + res.status, data?.error?.message ?? text);
    return data as T;
  }
  registerKey(publicKey: string) { return this.req<{ fingerprint: string }>("POST", "/v1/connectors/self/key", { publicKey }); }
  self() { return this.req<SelfInfo>("GET", "/v1/connectors/self"); }
  createJob(p: { routeId: string; payload: Envelope; idempotencyKey?: string; wait?: number }) { return this.req<JobView>("POST", "/v1/jobs", p); }
  getJob(id: string, wait = 0) { return this.req<JobView>("GET", `/v1/jobs/${encodeURIComponent(id)}?wait=${wait}`); }
  createDelivery(p: { deviceId?: string; title: string; body?: Envelope; content?: Envelope; ref?: string }) { return this.req<{ id: string; ids: string[] }>("POST", "/v1/deliveries", p); }
  inbox(since?: string, wait = 0) { return this.req<{ items: InboxItem[] }>("GET", `/v1/inbox?${since ? `since=${encodeURIComponent(since)}&` : ""}wait=${wait}`); }
  ackInbox(ids: string[]) { return this.req<{ ok: true }>("POST", "/v1/inbox/ack", { ids }); }
  getVariable(name: string) { return this.req<{ name: string; value: Envelope; updatedAt: string }>("GET", `/v1/variables/${encodeURIComponent(name)}`); }
  setVariable(name: string, value: Envelope) { return this.req<{ name: string; updatedAt: string }>("PUT", `/v1/variables/${encodeURIComponent(name)}`, { value }); }
  listVariables() { return this.req<{ variables: { name: string; updatedAt: string }[] }>("GET", "/v1/variables"); }
}
