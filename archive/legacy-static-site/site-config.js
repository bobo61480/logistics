/* ─────────────────────────────────────────────────────────────────────────────
   site-config.js — client-side runtime configuration

   HOW TO UPDATE
   1. Deploy google-apps-script/Code.gs as a domain-restricted web app
      (Execute as: Me · Who has access: Users in stylekoreanus.com).
   2. Copy the resulting /exec URL and replace completeEndpoint below.
   3. Never widen the access scope beyond @stylekoreanus.com.
   ───────────────────────────────────────────────────────────────────────────── */
"use strict";

(function (global) {
  /** @type {string} Google Apps Script /exec URL for order-completion writes. */
  const COMPLETE_ENDPOINT =
    "https://script.google.com/a/macros/stylekoreanus.com/s/" +
    "AKfycbwyVnU2jvOtMFXuY7KtX_8-hHXYVLrc6R2Dr_6akdDaTGQPc8duSo7tpguIuk00MjDl/exec";

  // Guard: warn loudly during development if the placeholder is still present.
  if (COMPLETE_ENDPOINT.includes("REPLACE_ME")) {
    console.warn("[site-config] completeEndpoint has not been configured.");
  }

  // Freeze the object so no other script can mutate the endpoint at runtime.
  global.STYLEKOREAN_CONFIG = Object.freeze({
    completeEndpoint: COMPLETE_ENDPOINT,
  });
}(typeof globalThis !== "undefined" ? globalThis : window));
