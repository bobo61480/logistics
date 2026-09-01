import worker from "./worker";

export { CmsSessionStore } from "./worker";

type CoreEnv = Parameters<typeof worker.fetch>[1];
type BootstrapEnv = CoreEnv & {
  CMS_SESSION_COOKIE?: string;
};

type SessionStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type SessionNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): SessionStub;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function unattendedConfigured(env: BootstrapEnv): boolean {
  return Boolean(
    text(env.CMS_AUTH_USER) &&
      text(env.CMS_AUTH_PASSWORD) &&
      text(env.CMS_TOTP_SECRET),
  );
}

function bootstrapNamespace(cookieHeader: string): SessionNamespace {
  const stub: SessionStub = {
    async fetch(input, init) {
      const url = new URL(String(input));
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname === "/session") {
        return Response.json({ cookieHeader }, { status: 200 });
      }
      if (method === "POST" && url.pathname === "/invalidate") {
        return Response.json({ ok: true }, { status: 200 });
      }
      if (method === "POST" && url.pathname === "/renew") {
        return Response.json(
          { ok: false, error: "CMS_AUTH_NOT_CONFIGURED" },
          { status: 503 },
        );
      }
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    },
  };

  return {
    idFromName: (name) => name,
    get: () => stub,
  };
}

function adaptedEnv(env: BootstrapEnv): CoreEnv {
  const cookie = text(env.CMS_SESSION_COOKIE);
  if (!cookie || unattendedConfigured(env)) return env;
  return {
    ...env,
    CMS_SESSION_STORE: bootstrapNamespace(cookie),
  } as CoreEnv;
}

export default {
  async fetch(request: Request, env: BootstrapEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const response = await worker.fetch(request, env);
      const body = await response.json<Record<string, unknown>>();
      return Response.json(
        {
          ...body,
          bootstrapSessionConfigured: Boolean(text(env.CMS_SESSION_COOKIE)),
        },
        {
          status: response.status,
          headers: response.headers,
        },
      );
    }

    return worker.fetch(request, adaptedEnv(env));
  },
} satisfies ExportedHandler<BootstrapEnv>;
