export interface ParseClientIpOpts {
  /** When true, `cf-connecting-ip` is trusted as the client IP. Default false. */
  trustCloudflare: boolean
  /** Transport-level peer address (e.g. ws.remoteAddress or server.requestIP().address). */
  remoteAddress?: string | null
}

/**
 * Resolves the originating client IP for audit logging only.
 *
 * Priority:
 *  1. `cf-connecting-ip` header — ONLY when Cloudflare is explicitly trusted
 *     (default false). Behind CF this is the real client IP; otherwise it is
 *     attacker-controlled and must never be trusted.
 *  2. `remoteAddress` — the transport peer (proxy/edge IP if behind one).
 *  3. `'unknown'` — no signal available.
 *
 * `x-forwarded-for` is intentionally NOT consulted: any client can forge it,
 * so it is untrustworthy even when a proxy is present.
 */
export function parseClientIp(headers: Headers, opts: ParseClientIpOpts): string {
  if (opts.trustCloudflare) {
    const cf = headers.get('cf-connecting-ip')
    if (cf) return cf
  }
  if (opts.remoteAddress) return opts.remoteAddress
  return 'unknown'
}
