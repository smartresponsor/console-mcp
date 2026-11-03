# Console MCP: no automatic rotation on Web form quota denial

A prior bridge rule translated the provider's
`WEB_OPERATION_LIMIT_REACHED` into automatic `/browser-restart` calls.
Even when `force=false`, the disconnect/reconnect could not guarantee
preservation of all external Edge tabs or the exact visible target.

The bridge now returns the provider outcome unchanged. It never rotates the worker
on quota denial, and never retries a form fill or final submit.

Expected Browsing provider outcomes:

- `WEB_RATE_LIMITED` — bounded sliding window with explicit
  `evidence.retryAfterSeconds`; consumer disposition `reinspect`, no automatic retry
- `WEB_OPERATION_SIZE_LIMIT` — oversized field set; consumer disposition
  `needs_correction`, no automatic retry
- Other errors preserve original status/evidence for diagnosis

The response retains the safe standard form approval, revision and postcondition
rules. Any future recovery must use a newly verified target and new approval
receipt. LinkedIn `CONNECT` and `COMMENT` remain queued until separate
per-action external postcondition verification.

Source-only: no runtime restart, no browser worker replacement, no live cutover.
