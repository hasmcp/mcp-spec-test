// Unit tests for the interactive OAuth flow.
//
// These are not conformance cases — they test this package rather than a server
// under test, which is why they live in tests/unit/ and not alongside the case
// files. They need no target and no network beyond loopback, so CI runs them on
// every push.
//
// The flow they cover is the one that is hardest to check by hand: it involves a
// browser, a redirect, and a secret that is never transmitted, so "I ran it once
// against a real server and it worked" is weak evidence. A mock authorization
// server that *verifies* the PKCE challenge is strong evidence, because it fails
// if the verifier and the challenge ever stop agreeing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

import {
  buildAuthorizationUrl,
  chooseCodeChallengeMethod,
  codeChallengeFor,
  pkcePair,
  startReceiver,
} from '../../lib/loopback.mjs'
import { chooseAuthMethod, obtainToken, supportsAuthorizationCode } from '../../lib/oauth.mjs'

// --- PKCE -------------------------------------------------------------------

test('the S256 challenge matches the RFC 7636 test vector', () => {
  // RFC 7636 Appendix B, verbatim. If this fails, the hash is being taken over
  // the wrong bytes and no real authorization server will accept the exchange.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  assert.equal(codeChallengeFor(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('a generated verifier is a legal length and unpadded base64url', () => {
  const { verifier, challenge, method } = pkcePair()
  assert.equal(method, 'S256')
  // RFC 7636 §4.1: 43–128 characters from the unreserved set.
  assert.ok(verifier.length >= 43 && verifier.length <= 128, verifier.length)
  for (const value of [verifier, challenge]) assert.match(value, /^[A-Za-z0-9\-._~]+$/)
  assert.equal(challenge, codeChallengeFor(verifier))
})

test('verifiers are not reused between flows', () => {
  const seen = new Set(Array.from({ length: 50 }, () => pkcePair().verifier))
  assert.equal(seen.size, 50)
})

test('plain is refused and S256 is required', () => {
  assert.deepEqual(
    chooseCodeChallengeMethod({ code_challenge_methods_supported: ['S256', 'plain'] }),
    { ok: true, method: 'S256', advertised: true },
  )
  // Absent is not disqualifying: OAuth 2.1 requires S256 of every server, and
  // RFC 8414 makes advertising it optional.
  assert.deepEqual(chooseCodeChallengeMethod({}), { ok: true, method: 'S256', advertised: false })

  const plainOnly = chooseCodeChallengeMethod({ code_challenge_methods_supported: ['plain'] })
  assert.equal(plainOnly.ok, false)
  assert.match(plainOnly.reason, /no S256/)
})

// --- the authorization request ----------------------------------------------

test('the authorization request carries what the spec requires', () => {
  const url = new URL(buildAuthorizationUrl(
    { authorization_endpoint: 'https://as.example/oauth2/authorize?tenant=acme' },
    {
      clientId: 'abc',
      redirectUri: 'http://127.0.0.1:1234/callback',
      state: 'st',
      codeChallenge: 'ch',
      scope: 'mcp:read',
      resource: 'https://mcp.example/mcp',
    },
  ))
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'abc')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1234/callback')
  assert.equal(url.searchParams.get('state'), 'st')
  assert.equal(url.searchParams.get('code_challenge'), 'ch')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  // RFC 8707 applies to the authorization request too, not only the token
  // request: without it the consent screen cannot say what is being granted.
  assert.equal(url.searchParams.get('resource'), 'https://mcp.example/mcp')
  assert.equal(url.searchParams.get('scope'), 'mcp:read')
  // A query already on the endpoint must survive, not be replaced.
  assert.equal(url.searchParams.get('tenant'), 'acme')
})

// --- the loopback receiver --------------------------------------------------

test('the receiver returns the code from a matching redirect', async () => {
  const receiver = await startReceiver()
  try {
    assert.match(receiver.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const waiting = receiver.waitForRedirect({ state: 'st', timeoutMs: 5000 })
    const res = await fetch(`${receiver.redirectUri}?code=the-code&state=st`)
    assert.equal(res.status, 200)
    const body = await res.text()
    // The page must not echo the code: it would land in browser history.
    assert.ok(!body.includes('the-code'))
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await waiting, { ok: true, code: 'the-code' })
  } finally {
    await receiver.close()
  }
})

test('the receiver refuses a redirect carrying the wrong state', async () => {
  const receiver = await startReceiver()
  try {
    const waiting = receiver.waitForRedirect({ state: 'st', timeoutMs: 5000 })
    await fetch(`${receiver.redirectUri}?code=the-code&state=somebody-elses`)
    const result = await waiting
    assert.equal(result.ok, false)
    assert.match(result.reason, /wrong state/)
    assert.equal(result.code, undefined)
  } finally {
    await receiver.close()
  }
})

test('the receiver reports the authorization server\'s own error', async () => {
  const receiver = await startReceiver()
  try {
    const waiting = receiver.waitForRedirect({ state: 'st', timeoutMs: 5000 })
    const res = await fetch(`${receiver.redirectUri}?error=access_denied&error_description=user+said+no&state=st`)
    assert.equal(res.status, 400)
    const result = await waiting
    assert.equal(result.ok, false)
    assert.match(result.reason, /access_denied: user said no/)
  } finally {
    await receiver.close()
  }
})

test('a stray request does not end the wait', async () => {
  const receiver = await startReceiver()
  try {
    const waiting = receiver.waitForRedirect({ state: 'st', timeoutMs: 5000 })
    // Browsers ask for this unprompted; resolving on it would abandon a flow
    // still in progress.
    const favicon = await fetch(new URL('/favicon.ico', receiver.redirectUri))
    assert.equal(favicon.status, 404)
    await fetch(`${receiver.redirectUri}?code=the-code&state=st`)
    assert.deepEqual(await waiting, { ok: true, code: 'the-code' })
  } finally {
    await receiver.close()
  }
})

test('the receiver gives up rather than waiting forever', async () => {
  const receiver = await startReceiver()
  try {
    const result = await receiver.waitForRedirect({ state: 'st', timeoutMs: 50 })
    assert.equal(result.ok, false)
    assert.match(result.reason, /no redirect to http:\/\/127\.0\.0\.1:\d+\/callback within/)
  } finally {
    await receiver.close()
  }
})

// --- client authentication --------------------------------------------------

test('a public client asks for "none" and a confidential one for a secret', () => {
  const metadata = { token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] }
  // The interactive flow has no secret to keep, so registering as
  // client_secret_basic would leave it unable to authenticate at all.
  assert.equal(chooseAuthMethod(metadata, { publicClient: true }), 'none')
  assert.equal(chooseAuthMethod(metadata), 'client_secret_basic')
  // A server that will not have a public client is followed, not argued with.
  assert.equal(
    chooseAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_post'] }, { publicClient: true }),
    'client_secret_post',
  )
})

test('authorization_code needs an endpoint to start at, not just the grant name', () => {
  assert.equal(supportsAuthorizationCode({ grant_types_supported: ['authorization_code'] }), false)
  assert.equal(supportsAuthorizationCode({
    authorization_endpoint: 'https://as.example/a',
    grant_types_supported: ['authorization_code'],
  }), true)
  assert.equal(supportsAuthorizationCode({
    authorization_endpoint: 'https://as.example/a',
    grant_types_supported: ['client_credentials'],
  }), false)
})

// --- end to end against a mock authorization server -------------------------

// mockServer stands in for both the MCP endpoint and its authorization server,
// on one loopback origin so the issuer check has something real to check.
//
// `grants` controls what it advertises, which is what selects the flow under
// test. Everything it receives is recorded so the assertions can be about the
// requests actually sent rather than about this package's own return values.
async function mockServer({ grants = ['authorization_code'], authMethods = ['none'], scopes } = {}) {
  const seen = { register: null, authorize: null, token: null }
  const challenges = new Map()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`)
    const origin = `http://127.0.0.1:${server.address().port}`
    const json = (status, body) => res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify(body))

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        ...(scopes ? { scopes_supported: scopes } : {}),
      })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth2/authorize`,
        token_endpoint: `${origin}/oauth2/token`,
        registration_endpoint: `${origin}/oauth2/register`,
        grant_types_supported: grants,
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: authMethods,
      })
    }
    if (url.pathname === '/oauth2/register') {
      seen.register = JSON.parse(await text(req))
      return json(201, { client_id: 'registered-client', token_endpoint_auth_method: 'none' })
    }
    if (url.pathname === '/oauth2/authorize') {
      seen.authorize = Object.fromEntries(url.searchParams)
      // Stand in for the user: consent is immediate, and the code is bound to
      // the challenge so the token endpoint can verify it.
      challenges.set('granted-code', {
        challenge: url.searchParams.get('code_challenge'),
        method: url.searchParams.get('code_challenge_method'),
        redirectUri: url.searchParams.get('redirect_uri'),
      })
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', 'granted-code')
      back.searchParams.set('state', url.searchParams.get('state'))
      return res.writeHead(302, { location: back.toString() }).end()
    }
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(await text(req))
      seen.token = Object.fromEntries(form)
      if (form.get('grant_type') === 'client_credentials') {
        return json(200, { access_token: 'machine-token', token_type: 'Bearer' })
      }
      const bound = challenges.get(form.get('code'))
      if (!bound) return json(400, { error: 'invalid_grant', error_description: 'unknown code' })
      // The whole point of the exercise: the verifier must hash to the
      // challenge that was presented at the authorization endpoint.
      const expected = createHash('sha256').update(form.get('code_verifier') ?? '', 'ascii').digest('base64url')
      if (expected !== bound.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      }
      if (form.get('redirect_uri') !== bound.redirectUri) {
        return json(400, { error: 'invalid_grant', error_description: 'redirect_uri does not match' })
      }
      return json(200, { access_token: 'interactive-token', token_type: 'Bearer' })
    }
    return json(404, { error: 'not_found' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function text(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// visitOnLog plays the part of the browser: the flow prints the authorization
// URL, and fetching it follows the redirect to the loopback receiver, which is
// exactly what a browser does. Driving it this way means the test exercises the
// real receiver rather than a stub of it.
function visitOnLog(lines) {
  return (line) => {
    lines.push(line)
    const match = /^ *(http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize\?\S+)$/.exec(line)
    if (match) fetch(match[1]).catch(() => {})
  }
}

test('an authorization_code-only server yields a token through the browser flow', async () => {
  const mock = await mockServer({ grants: ['authorization_code', 'refresh_token'], scopes: ['mcp:read'] })
  const lines = []
  try {
    const result = await obtainToken({
      mcpUrl: mock.mcpUrl,
      interactive: 'auto',
      launchBrowser: false,
      timeoutMs: 10_000,
      log: visitOnLog(lines),
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.accessToken, 'interactive-token')
    assert.equal(result.clientId, 'registered-client')

    // Registered for the grant it will actually use, with the port it actually
    // bound. RFC 7591 treats these as promises, and a mismatch fails later.
    assert.deepEqual(mock.seen.register.grant_types, ['authorization_code'])
    assert.deepEqual(mock.seen.register.response_types, ['code'])
    assert.equal(mock.seen.register.token_endpoint_auth_method, 'none')
    assert.match(mock.seen.register.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    assert.equal(mock.seen.register.redirect_uris[0], mock.seen.authorize.redirect_uri)

    // The resource is on both requests, and carries no query or fragment.
    assert.equal(mock.seen.authorize.resource, mock.mcpUrl)
    assert.equal(mock.seen.token.resource, mock.mcpUrl)
    // Scopes the resource published, since none were asked for.
    assert.equal(mock.seen.authorize.scope, 'mcp:read')
    // A public client sends its id in the body and no secret.
    assert.equal(mock.seen.token.client_id, 'registered-client')
    assert.equal(mock.seen.token.client_secret, undefined)
    // Nothing secret reaches the log.
    assert.ok(!lines.join('\n').includes('interactive-token'))
    assert.ok(!lines.join('\n').includes(mock.seen.token.code_verifier))
  } finally {
    await mock.close()
  }
})

test('client_credentials is preferred when both grants are on offer', async () => {
  const mock = await mockServer({
    grants: ['authorization_code', 'client_credentials'],
    authMethods: ['client_secret_basic'],
  })
  try {
    const result = await obtainToken({
      mcpUrl: mock.mcpUrl,
      interactive: 'auto',
      launchBrowser: false,
      log: () => {},
    })
    assert.equal(result.ok, true, result.reason)
    // No browser was opened and no redirect was waited for, because nothing
    // needed a person.
    assert.equal(result.accessToken, 'machine-token')
    assert.equal(mock.seen.authorize, null)
    assert.equal(mock.seen.token.grant_type, 'client_credentials')
  } finally {
    await mock.close()
  }
})

test('--interactive takes the browser flow even where a machine grant exists', async () => {
  const mock = await mockServer({ grants: ['authorization_code', 'client_credentials'] })
  try {
    const result = await obtainToken({
      mcpUrl: mock.mcpUrl,
      interactive: 'always',
      launchBrowser: false,
      timeoutMs: 10_000,
      log: visitOnLog([]),
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.accessToken, 'interactive-token')
    assert.equal(mock.seen.token.grant_type, 'authorization_code')
  } finally {
    await mock.close()
  }
})

test('with no browser allowed, the dead end names the switch that opens it', async () => {
  const mock = await mockServer({ grants: ['authorization_code'] })
  try {
    const result = await obtainToken({
      mcpUrl: mock.mcpUrl,
      interactive: 'never',
      log: () => {},
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /no client_credentials/)
    assert.match(result.reason, /--interactive/)
    // Nothing was created on the authorization server on the way to failing.
    assert.equal(mock.seen.register, null)
  } finally {
    await mock.close()
  }
})

test('registration disabled is reported before a browser is opened', async () => {
  const mock = await mockServer({ grants: ['authorization_code'] })
  const lines = []
  try {
    const result = await obtainToken({
      mcpUrl: mock.mcpUrl,
      interactive: 'always',
      allowRegistration: false,
      launchBrowser: false,
      log: (line) => lines.push(line),
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /--no-register/)
    assert.equal(mock.seen.authorize, null)
    assert.ok(!lines.some((l) => l.includes('/oauth2/authorize')))
  } finally {
    await mock.close()
  }
})
