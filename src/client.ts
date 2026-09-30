export type Envelope = { v: 1; enc: string; ct: string };
export type RouteTarget = { kind: "device" | "connector"; id: string; enabled: boolean; lastSuccessAt: string | null };
export type Route = { targets?: RouteTarget[]; routeId: string; name: string; shortcutName: string; executionMode: "auto" | "confirm"; dataKinds: string[]; deviceId: string; enabled: boolean; lastSuccessAt: string | null; createdAt: string; inputExample?: string | null; inputHint?: string | null; outputHint?: string | null };
export type SelfInfo = { stopped?: boolean; connectorId: string; name: string; fingerprint: string | null; fingerprintWords: string[] | null; verified: boolean; verifiedAt: string | null; mode: "e2e" | "server"; accountKey: Envelope | null; devices: { deviceId: string; publicKey: string; fingerprint: string; name: string | null; lastSeenAt: string | null }[]; routes: Route[] };
export type JobView = { jobId: string; status: string; routeId: string; createdAt: string; result?: Envelope; error?: string; note?: string; timeline: { step: string; at: string; by: string; note?: string }[] };
export type InboxItem = { id: string; deviceId: string; payload: Envelope; ref: string | null; kind: string; createdAt: string };

/** 서버가 내려주는 공개 레시피 목록의 한 항목(`GET /v1/recipes`). 에이전트에게 필요한 칸만. */
export type CatalogRecipe = { id: string; kind: "route" | "dispatcher"; name: string; route?: string; shortcutName: string; oneLine?: string;
  input?: unknown; output?: string; verified?: boolean; audience?: "agent" | "both" | "solo"; direction?: string; app?: string;
  ipad?: { support: string; note?: string } };

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
  /** 에이전트가 맥에서 만든 레시피를 올린다. 서명본은 서버가 못 읽으므로 조립 원본을 같이 보낸다. */
  uploadRecipe(name: string, fileB64: string, workflow: Record<string, unknown>) {
    return this.req<{ recipe: { id: string; name: string; review: unknown; verifiedRun: string | null } }>(
      "POST", "/v1/recipes/agent", { name, file: fileB64, workflow });
  }
  self() { return this.req<SelfInfo>("GET", "/v1/connectors/self"); }
  /** 공개 목록이라 키가 없어도 된다. */
  async recipes() { return (await this.req<{ recipes?: CatalogRecipe[] }>("GET", "/v1/recipes")).recipes ?? []; }
  createJob(p: { routeId: string; target?: { kind: "device" | "connector"; id: string }; payload: Envelope; idempotencyKey?: string; wait?: number }) { return this.req<JobView>("POST", "/v1/jobs", p); }
  getJob(id: string, wait = 0) { return this.req<JobView>("GET", `/v1/jobs/${encodeURIComponent(id)}?wait=${wait}`); }
  /** 기기별 봉투를 한 요청에 담는다(`targets`). 기기가 하나면 `deviceId` 형태도 그대로 받는다. */
  createDelivery(p: { deviceId?: string; targets?: { deviceId: string; body?: Envelope; content?: Envelope }[]; title: string; body?: Envelope; content?: Envelope; ref?: string }) { return this.req<{ id: string; ids: string[] }>("POST", "/v1/deliveries", p); }
  inbox(since?: string, wait = 0) { return this.req<{ items: InboxItem[] }>("GET", `/v1/inbox?${since ? `since=${encodeURIComponent(since)}&` : ""}wait=${wait}`); }
  ackInbox(ids: string[]) { return this.req<{ ok: true }>("POST", "/v1/inbox/ack", { ids }); }
  getVariable(name: string) { return this.req<{ name: string; value: Record<string, unknown>; updatedAt: string }>("GET", `/v1/variables/${encodeURIComponent(name)}`); }
  setVariable(name: string, value: Record<string, unknown>) { return this.req<{ name: string; updatedAt: string }>("PUT", `/v1/variables/${encodeURIComponent(name)}`, { value }); }
  listVariables() { return this.req<{ variables: { name: string; updatedAt: string }[] }>("GET", "/v1/variables"); }
}
