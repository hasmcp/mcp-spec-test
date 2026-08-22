// The interactive half of OAuth: PKCE, a loopback redirect, and a browser.
//
// An authorization server that only issues tokens through authorization_code
// needs a user at a browser, and a command-line tool can be that — it is what
// every OAuth-capable CLI does, MCP clients included. The mechanism is RFC 8252
// (OAuth for Native Apps): bind an HTTP server to a loopback address on an
// ephemeral port, hand the authorization server that address as the redirect,
// open the user's browser, and read the authorization code out of the one
// request that comes back. The server exists for the duration of one redirect
// and is closed either way.
//
// PKCE (RFC 7636) is what makes this safe without a client secret. The loopback
// redirect is the weak point of the native-app flow — any process on the machine
// can race for the port, and the code arrives over plain http — so the code is
// bound to a secret this process generated and never transmitted. Without it an
// intercepted code is redeemable; with it, it is inert. OAuth 2.1 makes it
// mandatory for authorization_code, and this only ever offers S256: `plain`
// sends the verifier in the authorization request, which defeats the point.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

// base64url without padding, which is what RFC 7636 §4.2 and RFC 4648 §5 ask for
// in these parameters. Node can emit it directly; the replace is for older
// runtimes that pad regardless.
function base64url(buffer) {
  return buffer.toString('base64url').replace(/=+$/, '')
}

// codeChallengeFor derives the S256 challenge from a verifier.
//
// The hash is over the *ASCII of the verifier string*, not over the bytes it
// would decode to. RFC 7636 §4.2 is explicit about it and it is the single
// easiest thing to get wrong here, because the wrong version produces a flow
// that works perfectly up to the token request and then fails as
// `invalid_grant` with nothing to point at. Separated from pkcePair so it can be
// checked against the RFC's own test vector.
export function codeChallengeFor(verifier) {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest())
}

// pkcePair generates a verifier and its S256 challenge.
//
// 32 random bytes become a 43-character verifier, the shortest length RFC 7636
// §4.1 permits and the one every implementation agrees on.
export function pkcePair() {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: codeChallengeFor(verifier), method: 'S256' }
}

// A `state` value, which is what ties the redirect this process receives to the
// authorization request it made. Anything can hit a loopback port; only the
// request carrying this value is ours.
export function newState() {
  return base64url(randomBytes(16))
}

// chooseCodeChallengeMethod reads the authorization server's advertised PKCE
// support and insists on S256.
//
// A server that advertises only `plain` is refused rather than accommodated.
// `plain` puts the verifier itself in the authorization request — which travels
// through the browser, the address bar, and the server's logs — so using it
// would leave the flow no safer than one with no PKCE at all, while looking like
// it had some.
export function chooseCodeChallengeMethod(asMetadata) {
  const methods = asMetadata?.code_challenge_methods_supported
  // Absent is common and not disqualifying: RFC 8414 makes the field optional,
  // and OAuth 2.1 requires S256 support of every authorization server. Trying it
  // is the right move — a server that genuinely cannot will say so.
  if (!Array.isArray(methods) || methods.length === 0) return { ok: true, method: 'S256', advertised: false }
  if (methods.includes('S256')) return { ok: true, method: 'S256', advertised: true }
  return {
    ok: false,
    reason: `advertises code_challenge_methods_supported ${JSON.stringify(methods)} — no S256. `
      + 'Only S256 is used here: "plain" sends the verifier through the browser, which is worse '
      + 'than no PKCE while looking like PKCE.',
  }
}

// The page the browser lands on. Deliberately plain: it is shown for a second in
// a tab the user is about to close, it must render with no network of its own,
// and it must never contain the authorization code — a page that echoed the code
// would put it in the browser's history and its cache.
function completionPage(heading, detail) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${heading}</title>
<style>
  :root { color-scheme: light dark }
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-content: center; text-align: center; padding: 2rem }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem }
  p { margin: 0; opacity: .7 }
</style></head>
<body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>
`
}

// startReceiver binds the loopback server and returns before anything is opened,
// so the caller can build a redirect URI that names the port it actually got.
//
// Port 0 asks the OS for a free one, which is what RFC 8252 §7.3 expects of a
// native client and why the authorization server is required to allow a varying
// port on a loopback redirect. Some do not, so `port` can be pinned.
export async function startReceiver({ host = '127.0.0.1', port = 0, path = '/callback' } = {}) {
  let settle = null
  const received = new Promise((resolve) => { settle = resolve })

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`)

    // Browsers ask for /favicon.ico unprompted, and a stray request must not be
    // mistaken for the redirect — answering everything would resolve the wait
    // with no code and abandon a flow that was still in progress.
    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n')
      return
    }

    const params = url.searchParams
    const error = params.get('error')
    const html = error
      ? completionPage('Authorization failed', 'Nothing was granted. Return to the terminal for details.')
      : completionPage('Authorized', 'You can close this tab and return to the terminal.')
    res.writeHead(error ? 400 : 200, {
      'content-type': 'text/html; charset=utf-8',
      // The URL of this request carries the authorization code, so nothing about
      // it should be kept or handed onwards.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    }).end(html)

    settle({
      code: params.get('code'),
      state: params.get('state'),
      error,
      errorDescription: params.get('error_description'),
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const actualPort = server.address().port
  return {
    redirectUri: `http://${host}:${actualPort}${path}`,
    port: actualPort,
    // waitForRedirect resolves with the redirect's parameters, or with a reason
    // it never came. It does not throw: "the user closed the tab" is an outcome
    // to report, not an exception.
    async waitForRedirect({ timeoutMs = 180_000, state } = {}) {
      let timer
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
        // A stray timer must not be what keeps the process alive once the
        // redirect has landed.
        timer.unref?.()
      })
      const result = await Promise.race([received, timedOut])
      clearTimeout(timer)

      if (result.timeout) {
        return { ok: false, reason: `no redirect to ${this.redirectUri} within ${Math.round(timeoutMs / 1000)}s` }
      }
      if (result.error) {
        const detail = result.errorDescription ? `: ${result.errorDescription}` : ''
        return { ok: false, reason: `the authorization server returned ${result.error}${detail}` }
      }
      // Checked before the code is used for anything. A redirect carrying the
      // wrong state is not this flow's redirect, and treating it as one is the
      // CSRF the parameter exists to prevent.
      if (state && result.state !== state) {
        return { ok: false, reason: 'the redirect carried the wrong state, so it did not belong to this request' }
      }
      if (!result.code) return { ok: false, reason: 'the redirect carried no authorization code' }
      return { ok: true, code: result.code }
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

// openInBrowser hands a URL to the desktop's own handler.
//
// Best-effort by design. Over SSH, in a container, or under a stripped-down
// desktop there is nothing to open, and that is not a failure — the caller
// always prints the URL too, so a user who has to paste it can. What would be a
// failure is blocking on the child or letting its exit status abort the run, so
// it is detached and its outcome ignored.
export function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      // The empty string is the window title `start` consumes; without it a URL
      // containing an `&` is read as the title and the rest as a new command.
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

// buildAuthorizationUrl assembles the authorization request.
//
// `resource` is on it deliberately. RFC 8707 defines the parameter for both the
// authorization and the token request, and the MCP spec requires it on both: an
// authorization server that only sees the audience at token time cannot show the
// user what they are granting access to, and cannot refuse a resource the client
// is not allowed to ask for.
export function buildAuthorizationUrl(asMetadata, {
  clientId, redirectUri, state, codeChallenge, codeChallengeMethod = 'S256', scope, resource,
}) {
  const url = new URL(asMetadata.authorization_endpoint)
  const params = url.searchParams
  params.set('response_type', 'code')
  params.set('client_id', clientId)
  params.set('redirect_uri', redirectUri)
  params.set('state', state)
  params.set('code_challenge', codeChallenge)
  params.set('code_challenge_method', codeChallengeMethod)
  if (resource) params.set('resource', resource)
  if (scope) params.set('scope', scope)
  return url.toString()
}
