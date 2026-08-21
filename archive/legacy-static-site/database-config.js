"use strict";

/**
 * Supabase configuration for the StyleKorean storefront.
 *
 * SECURITY NOTES
 * - `publishableKey` is the anon/public key.  It is safe to ship in the
 *   browser **only** because Row-Level Security (RLS) is enforced on every
 *   table.  Never place a service-role / secret key here.
 * - Only set `enabled: true` after all DB migrations and the initial
 *   data-source sync have completed.
 * - Only set `preferDatabase: true` once you have verified that the DB
 *   reflects the live catalogue accurately.
 *
 * @typedef {Object} DatabaseConfig
 * @property {boolean} enabled        - Master switch: enables DB reads.
 * @property {boolean} preferDatabase - When true, DB data takes priority over
 *                                      the scraped/static source.
 * @property {string}  url            - Supabase project URL
 *                                      (e.g. "https://<ref>.supabase.co").
 * @property {string}  publishableKey - Supabase anon key (public, non-secret).
 * @property {string}  allowedDomain  - Hostname that may call the DB; used as
 *                                      a client-side guard against accidental
 *                                      cross-origin usage.
 */

/** @type {Readonly<DatabaseConfig>} */
window.STYLEKOREAN_DATABASE = Object.freeze({
  enabled: false,
  preferDatabase: false,
  url: "",
  publishableKey: "",
  allowedDomain: "stylekoreanus.com",
});

// Warn early in development if the config is activated without required values.
if (window.STYLEKOREAN_DATABASE.enabled) {
  const { url, publishableKey } = window.STYLEKOREAN_DATABASE;
  if (!url || !publishableKey) {
    console.error(
      "[STYLEKOREAN_DATABASE] `enabled` is true but `url` or " +
        "`publishableKey` is empty. Database calls will fail."
    );
  }
}
