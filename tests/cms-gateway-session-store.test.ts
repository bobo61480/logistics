import { describe, expect, it, vi } from "vitest";
import {
  SessionCoordinator,
  publicSessionHealth,
  shouldRenewSession,
  shouldValidateSession,
  type SessionStorage,
  type StoredCmsSession,
} from "../cms-gateway/session-store";

const NOW = Date.parse("2026-09-01T07:00:00.000Z");
const AUTH_ENV = {
  CMS_AUTH_USER: "fixture-user",
  CMS_AUTH_PASSWORD: "fixture-password",
  CMS_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};

function session(overrides: Partial<StoredCmsSession> = {}): StoredCmsSession {
  return {
    cookieHeader: "CMS_E=fixture-cookie",
    createdAt: "2026-09-01T06:00:00.000Z",
    expiresAt: "2026-09-01T09:00:00.000Z",
    lastValidatedAt: "2026-09-01T06:58:00.000Z",
    ...overrides,
  };
}

class MemoryStorage implements SessionStorage {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

describe("CMS session renewal policy", () => {
  it("renews a missing or near-expiry session but reuses a healthy session", () => {
    expect(shouldRenewSession(null, NOW)).toBe(true);
    expect(
      shouldRenewSession(session({ expiresAt: new Date(NOW + 14 * 60_000).toISOString() }), NOW),
    ).toBe(true);
    expect(
      shouldRenewSession(session({ expiresAt: new Date(NOW + 16 * 60_000).toISOString() }), NOW),
    ).toBe(false);
  });

  it("validates expiration-less sessions no more than every ten minutes", () => {
    expect(
      shouldValidateSession(
        session({ expiresAt: null, lastValidatedAt: new Date(NOW - 9 * 60_000).toISOString() }),
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldValidateSession(
        session({ expiresAt: null, lastValidatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
        NOW,
      ),
    ).toBe(true);
  });

  it("builds health metadata without exposing the cookie header", () => {
    const health = publicSessionHealth(session(), NOW, true, false);
    expect(health).toMatchObject({
      unattendedAuthConfigured: true,
      cmsSessionState: "valid",
      cmsSessionCreatedAt: "2026-09-01T06:00:00.000Z",
      cmsSessionExpiresAt: "2026-09-01T09:00:00.000Z",
      cmsSessionLastValidatedAt: "2026-09-01T06:58:00.000Z",
    });
    expect(JSON.stringify(health)).not.toContain("fixture-cookie");
    expect(health).not.toHaveProperty("cookieHeader");
  });
});

describe("SessionCoordinator", () => {
  it("renews a missing session and persists the new value", async () => {
    const storage = new MemoryStorage();
    const factory = vi.fn().mockResolvedValue({
      cookieHeader: "CMS_E=new-cookie",
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    const coordinator = new SessionCoordinator(storage, AUTH_ENV, factory);

    const result = await coordinator.getValidSession(NOW);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.cookieHeader).toBe("CMS_E=new-cookie");
    expect(await storage.get<StoredCmsSession>("cms-session")).toMatchObject({
      cookieHeader: "CMS_E=new-cookie",
    });
  });

  it("reuses a healthy session without logging in again", async () => {
    const storage = new MemoryStorage();
    await storage.put("cms-session", session());
    const factory = vi.fn();
    const coordinator = new SessionCoordinator(storage, AUTH_ENV, factory);

    const result = await coordinator.getValidSession(NOW);

    expect(result.cookieHeader).toBe("CMS_E=fixture-cookie");
    expect(factory).not.toHaveBeenCalled();
  });

  it("proactively renews a session with fifteen minutes or less remaining", async () => {
    const storage = new MemoryStorage();
    await storage.put(
      "cms-session",
      session({ expiresAt: new Date(NOW + 15 * 60_000).toISOString() }),
    );
    const factory = vi.fn().mockResolvedValue({
      cookieHeader: "CMS_E=renewed",
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    const coordinator = new SessionCoordinator(storage, AUTH_ENV, factory);

    expect((await coordinator.getValidSession(NOW)).cookieHeader).toBe("CMS_E=renewed");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent renewal calls into one login attempt", async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = vi.fn(async () => {
      await gate;
      return {
        cookieHeader: "CMS_E=single-flight",
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
      };
    });
    const coordinator = new SessionCoordinator(storage, AUTH_ENV, factory);

    const first = coordinator.getValidSession(NOW);
    const second = coordinator.getValidSession(NOW);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.cookieHeader).toBe("CMS_E=single-flight");
    expect(b.cookieHeader).toBe("CMS_E=single-flight");
  });

  it("invalidation clears the stored session", async () => {
    const storage = new MemoryStorage();
    await storage.put("cms-session", session());
    const coordinator = new SessionCoordinator(storage, AUTH_ENV, vi.fn());

    await coordinator.invalidate();

    expect(await storage.get("cms-session")).toBeUndefined();
  });

  it("preserves a still-valid stored session when a forced renewal fails", async () => {
    const storage = new MemoryStorage();
    await storage.put("cms-session", session());
    const factory = vi.fn().mockRejectedValue(new Error("CMS_AUTH_RENEWAL_FAILED"));
    const coordinator = new SessionCoordinator(storage, AUTH_ENV, factory);

    await expect(coordinator.renewSession(NOW)).rejects.toThrow("CMS_AUTH_RENEWAL_FAILED");

    expect(await storage.get<StoredCmsSession>("cms-session")).toMatchObject({
      cookieHeader: "CMS_E=fixture-cookie",
    });
  });
});
