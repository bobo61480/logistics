import {
  CmsAuthError,
  createCmsSession,
  validateCmsSession,
  type CmsAuthEnv,
  type CmsSession,
} from "./auth";

const SESSION_KEY = "cms-session";
const RENEW_WINDOW_MS = 15 * 60_000;
const VALIDATION_INTERVAL_MS = 10 * 60_000;

export type StoredCmsSession = CmsSession & {
  lastValidatedAt: string | null;
};

export interface SessionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

type SessionFactory = (env: CmsAuthEnv) => Promise<CmsSession>;
type SessionValidator = (cookieHeader: string) => Promise<void>;

type DurableObjectStateLike = {
  storage: SessionStorage;
};

export type SessionHealth = {
  unattendedAuthConfigured: boolean;
  cmsSessionState: "valid" | "renewing" | "expired" | "missing" | "error";
  cmsSessionCreatedAt: string | null;
  cmsSessionExpiresAt: string | null;
  cmsSessionLastValidatedAt: string | null;
};

export function unattendedAuthConfigured(env: Partial<CmsAuthEnv>): boolean {
  return Boolean(
    String(env.CMS_AUTH_USER ?? "").trim() &&
      String(env.CMS_AUTH_PASSWORD ?? "").trim() &&
      String(env.CMS_TOTP_SECRET ?? "").trim(),
  );
}

export function shouldRenewSession(
  session: StoredCmsSession | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!session) return true;
  if (!session.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - nowMs <= RENEW_WINDOW_MS;
}

export function shouldValidateSession(
  session: StoredCmsSession | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!session || session.expiresAt) return false;
  if (!session.lastValidatedAt) return true;
  const lastValidatedAt = Date.parse(session.lastValidatedAt);
  if (!Number.isFinite(lastValidatedAt)) return true;
  return nowMs - lastValidatedAt >= VALIDATION_INTERVAL_MS;
}

export function publicSessionHealth(
  session: StoredCmsSession | null | undefined,
  nowMs: number,
  configured: boolean,
  renewing: boolean,
): SessionHealth {
  let state: SessionHealth["cmsSessionState"] = "missing";
  if (renewing) {
    state = "renewing";
  } else if (session) {
    const expiresAt = session.expiresAt ? Date.parse(session.expiresAt) : Number.POSITIVE_INFINITY;
    state = Number.isFinite(expiresAt) && expiresAt <= nowMs ? "expired" : "valid";
  } else if (!configured) {
    state = "missing";
  }

  return {
    unattendedAuthConfigured: configured,
    cmsSessionState: state,
    cmsSessionCreatedAt: session?.createdAt ?? null,
    cmsSessionExpiresAt: session?.expiresAt ?? null,
    cmsSessionLastValidatedAt: session?.lastValidatedAt ?? null,
  };
}

export class SessionCoordinator {
  private renewalPromise: Promise<StoredCmsSession> | null = null;

  constructor(
    private readonly storage: SessionStorage,
    private readonly env: CmsAuthEnv,
    private readonly sessionFactory: SessionFactory = createCmsSession,
    private readonly validator: SessionValidator = validateCmsSession,
  ) {}

  get renewing(): boolean {
    return this.renewalPromise !== null;
  }

  async getStoredSession(): Promise<StoredCmsSession | null> {
    return (await this.storage.get<StoredCmsSession>(SESSION_KEY)) ?? null;
  }

  async getValidSession(nowMs = Date.now()): Promise<StoredCmsSession> {
    const stored = await this.getStoredSession();
    if (shouldRenewSession(stored, nowMs)) {
      return this.renewSession(nowMs);
    }

    if (stored && shouldValidateSession(stored, nowMs)) {
      try {
        await this.validator(stored.cookieHeader);
        const validated: StoredCmsSession = {
          ...stored,
          lastValidatedAt: new Date(nowMs).toISOString(),
        };
        await this.storage.put(SESSION_KEY, validated);
        return validated;
      } catch {
        await this.invalidate();
        return this.renewSession(nowMs);
      }
    }

    if (!stored) throw new CmsAuthError("CMS_AUTH_RENEWAL_FAILED");
    return stored;
  }

  async renewSession(nowMs = Date.now()): Promise<StoredCmsSession> {
    if (this.renewalPromise) return this.renewalPromise;

    const renewal = (async () => {
      try {
        const created = await this.sessionFactory(this.env);
        const stored: StoredCmsSession = {
          ...created,
          lastValidatedAt: new Date(nowMs).toISOString(),
        };
        await this.storage.put(SESSION_KEY, stored);
        return stored;
      } catch (error) {
        if (error instanceof CmsAuthError) throw error;
        throw new CmsAuthError("CMS_AUTH_RENEWAL_FAILED");
      }
    })();

    this.renewalPromise = renewal;
    try {
      return await renewal;
    } finally {
      if (this.renewalPromise === renewal) this.renewalPromise = null;
    }
  }

  async invalidate(): Promise<void> {
    await this.storage.delete(SESSION_KEY);
  }

  async health(nowMs = Date.now()): Promise<SessionHealth> {
    const stored = await this.getStoredSession();
    return publicSessionHealth(stored, nowMs, unattendedAuthConfigured(this.env), this.renewing);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export class CmsSessionStore {
  private readonly coordinator: SessionCoordinator;

  constructor(state: DurableObjectStateLike, env: CmsAuthEnv) {
    this.coordinator = new SessionCoordinator(state.storage, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/session") {
        const session = await this.coordinator.getValidSession();
        return json(session);
      }
      if (request.method === "POST" && url.pathname === "/renew") {
        const session = await this.coordinator.renewSession();
        return json(session);
      }
      if (request.method === "POST" && url.pathname === "/invalidate") {
        await this.coordinator.invalidate();
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json(await this.coordinator.health());
      }
      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      const code = error instanceof CmsAuthError ? error.code : "CMS_AUTH_RENEWAL_FAILED";
      const status = code === "CMS_AUTH_NOT_CONFIGURED" ? 503 : 502;
      return json({ ok: false, error: code }, status);
    }
  }
}
