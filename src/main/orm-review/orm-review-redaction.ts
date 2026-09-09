/**
 * Credential redaction for ORM review targets and command output.
 * The mask is by construction: redaction happens before any value crosses
 * into evidence records, the wire, or agent context.
 */

const MASK = '****'

/** Mask userinfo password and query-string values in a connection URL. */
export function redactConnectionUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    // Not a parseable URL — mask anything after `://` up to `@`, and any query.
    return rawUrl
      .replace(/(\/\/)[^/@]+@/, `$1${MASK}@`)
      .replace(/\?.*$/, '?')
  }
  // No credentials or query params: return the input verbatim so schemes like
  // `file:./dev.db` keep their original, user-recognisable form.
  if (!url.username && !url.password && [...url.searchParams.keys()].length === 0) {
    return rawUrl
  }
  if (url.password) {
    url.password = MASK
  }
  if (url.username && !url.password) {
    url.username = MASK
  }
  const redactedQuery = [...url.searchParams.keys()]
    .map((key) => `${key}=${MASK}`)
    .join('&')
  const base = url.toString().split('?')[0]
  return redactedQuery ? `${base}?${redactedQuery}` : base
}

/**
 * Remove every occurrence of a known secret (exact connection URL and its
 * password component) from arbitrary text such as command output.
 */
export function redactSecretsFromText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (!secret) {
      continue
    }
    out = out.split(secret).join(MASK)
    try {
      const password = new URL(secret).password
      if (password && password.length >= 4) {
        out = out.split(password).join(MASK)
      }
    } catch {
      // Not a URL; the exact-string pass above already covered it.
    }
  }
  return out
}
