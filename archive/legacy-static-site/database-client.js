"use strict";

(() => {
  const config = window.STYLEKOREAN_DATABASE || {};
  let client = null;

  /** Options passed once to createClient; extracted for visibility. */
  const AUTH_OPTIONS = {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  };

  // ---------------------------------------------------------------------------
  // Core client helpers
  // ---------------------------------------------------------------------------

  function configured() {
    return Boolean(
      config.enabled &&
      config.url &&
      config.publishableKey &&
      window.supabase?.createClient
    );
  }

  function getClient() {
    if (!configured()) return null;
    if (!client) {
      client = window.supabase.createClient(config.url, config.publishableKey, AUTH_OPTIONS);
    }
    return client;
  }

  async function session() {
    const db = getClient();
    if (!db) return null;
    const { data } = await db.auth.getSession();
    return data.session ?? null;
  }

  // ---------------------------------------------------------------------------
  // Auth actions
  // ---------------------------------------------------------------------------

  async function signIn(email) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) throw new Error("Enter your email address.");
    if (!normalized.endsWith(`@${config.allowedDomain}`)) {
      throw new Error(`Use your @${config.allowedDomain} email.`);
    }
    const db = getClient();
    if (!db) throw new Error("Database is not configured yet.");
    const { error } = await db.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    if (error) throw error;
  }

  async function signOut() {
    const db = getClient();
    if (db) await db.auth.signOut();
    // Best-effort UI refresh — errors here must not surface as unhandled rejections.
    try { await mount(); } catch { /* DOM may not be present in all contexts */ }
  }

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------

  async function listShipments() {
    const db = getClient();
    if (!db) return [];
    const currentSession = await session();
    if (!currentSession) return [];
    const { data, error } = await db
      .from("shipments")
      .select("*, sources(label, source_key, source_url)")
      .is("deleted_at", null)
      .order("scheduled_at", { ascending: true, nullsFirst: false });
    if (error) throw error;
    return data ?? [];
  }

  async function updateShipment(id, expectedVersion, patch) {
    const db = getClient();
    if (!db) throw new Error("Sign in before editing.");
    const currentSession = await session();
    if (!currentSession) throw new Error("Sign in before editing.");
    const { data, error } = await db.rpc("update_shipment", {
      p_id: id,
      p_expected_version: expectedVersion,
      p_patch: patch,
    });
    if (error) throw error;
    return data;
  }

  // ---------------------------------------------------------------------------
  // UI mount
  // ---------------------------------------------------------------------------

  async function mount() {
    const status = document.getElementById("databaseStatus");
    const form = document.getElementById("databaseSignIn");
    const signOutButton = document.getElementById("databaseSignOut");
    if (!status || !form || !signOutButton) return;

    if (!configured()) {
      status.innerHTML =
        "<strong>Sheets fallback active</strong>" +
        "<span>Database activation pending · dashboard remains fully operational</span>";
      form.hidden = true;
      signOutButton.hidden = true;
      return;
    }

    const current = await session();
    const emailSpan = document.createElement("span");

    if (current) {
      status.innerHTML = "<strong>Database connected</strong>";
      emailSpan.textContent = `${current.user.email} · realtime-ready secured workspace`;
    } else {
      status.innerHTML = "<strong>Database ready</strong>";
      emailSpan.textContent =
        "Sign in with your StyleKorean member email to edit synchronized records";
    }
    status.appendChild(emailSpan);

    form.hidden = Boolean(current);
    signOutButton.hidden = !current;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    mount().catch(console.error);

    document.getElementById("databaseSignIn")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const result = document.getElementById("databaseResult");
      try {
        result.textContent = "Sending secure sign-in link…";
        await signIn(new FormData(event.currentTarget).get("email"));
        result.textContent = "Check your email for the sign-in link.";
      } catch (error) {
        result.textContent = error.message;
      }
    });

    document.getElementById("databaseSignOut")?.addEventListener("click", signOut);
  });

  window.StyleKoreanDatabase = Object.freeze({
    configured,
    session,
    signIn,
    signOut,
    listShipments,
    updateShipment,
    mount,
  });
})();
