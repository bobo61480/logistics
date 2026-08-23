# Public access policy

Decision recorded on 2026-08-13: `stylekorean.dpdns.org` remains public and is
not placed behind Cloudflare Access.

## Effective policy

- Pages and snapshot APIs are public.
- Status writes remain unauthenticated so the existing browser workflow keeps
  working without an employee login.
- Status writes accept only the approved relation kinds, source sheets, source
  rows, and normalized status vocabulary.
- Cross-origin browser writes, oversized commands, and non-JSON requests are
  rejected.
- Cloudflare limits the status endpoint to 30 accepted requests per 60 seconds
  for each client IP in each Cloudflare location. This is abuse mitigation, not
  authentication, and Cloudflare's counters are intentionally eventually
  consistent.
- Confirmed writes emit a correlation ID and a privacy-minimized Worker log. D1
  also records the event when the database binding is active.

## Accepted limitation

A direct HTTP client can still submit a syntactically valid status change. Rate
limiting reduces automated abuse but does not establish user identity or
authorization. Do not describe the public configuration as secure employee
authentication.

## Future rollback of this decision

If authenticated access is later required, put the pages and `/api/*` routes
behind Cloudflare Access using the company Google Workspace identity provider,
then add an Access service-token path only for approved automations. Re-run the
production smoke verifier after the policy change.
