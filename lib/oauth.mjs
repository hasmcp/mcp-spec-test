// OAuth 2.1 for a machine client.
//
// The spec's discovery chain is prescriptive, so this implements it rather than
// improvising: a 401's WWW-Authenticate names the protected-resource metadata,
// that names the authorization servers, and each server's metadata names the
// token and registration endpoints. Where the client has no credentials and the
// authorization server offers Dynamic Client Registration, it registers itself —
// which is the fallback the spec prescribes, not a shortcut around it.
//
// Two grants, because authorization servers are split between them.
// client_credentials comes first: it needs no browser and no user, which is
// exactly what a CI run is. Where it is not on offer — and plenty of servers
// only issue tokens through authorization_code — the interactive flow takes
// over, using the loopback redirect and PKCE in lib/loopback.mjs and the
// operator's own browser.
//
// Which one runs is not left to chance. Opening a browser is a side effect on
// somebody's desktop, so it happens when there is a terminal to notice it and
// never behind CI's back; --interactive and --no-interactive settle it outright.

import {
  buildAuthorizationUrl,
  chooseCodeChallengeMethod,
  newState,
  openInBrowser,
  pkcePair,
  startReceiver,
} from './loopback.mjs'

const CLIENT_NAME = 'mcp-spec-test'

// canonicalResource builds the RFC 8707 resource identifier for the endpoint
// under test: the MCP server's URI with no fragment and no query. Credentials
// often ride in the query string, and a token audience must not be keyed to a
// secret.
export function canonicalResource(rawUrl) {
  const url = new URL(rawUrl)
  url.hash = ''
  url.search = ''
  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase()
  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '')
}

// parseResourceMetadataUrl pulls resource_metadata out of a WWW-Authenticate
// header. The header is a challenge list with quoted parameters, so this looks
// for the one parameter that matters rather than parsing the whole grammar.
export function parseResourceMetadataUrl(header) {
  if (!header) return null
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)
    ?? /resource_metadata\s*=\s*([^,\s]+)/i.exec(header)
  return match ? match[1] : null
}

// Never throws. Metadata often lives on a different host from the MCP endpoint,
// and that host being unreachable is one more candidate that did not work — not a
// reason to abandon the discovery chain, and certainly not a stack trace.
async function getJson(url, { headers = {} } = {}) {
  let res
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers } })
  } catch (err) {
    return { ok: false, url, error: `unreachable: ${err?.cause?.code ?? err.message}` }
  }
  if (!res.ok) return { ok: false, status: res.status, url }
  try {
    return { ok: true, status: res.status, url, body: await res.json() }
  } catch (err) {
    return { ok: false, status: res.status, url, error: `not JSON: ${err.message}` }
  }
}

// protectedResourceMetadataUrls returns the well-known candidates, in the order
// the spec requires: the path-scoped form first, then the root.
export function protectedResourceMetadataUrls(mcpUrl) {
  const url = new URL(mcpUrl)
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  const base = `${url.protocol}//${url.host}`
  const candidates = []
  if (path) candidates.push(`${base}/.well-known/oauth-protected-resource/${path}`)
  candidates.push(`${base}/.well-known/oauth-protected-resource`)
  return candidates
}

// authorizationServerMetadataUrls returns the candidates for an issuer. The order
// and the path handling are both specified: an issuer with a path component gets
// three candidates, one without gets two.
export function authorizationServerMetadataUrls(issuer) {
  const url = new URL(issuer)
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  const base = `${url.protocol}//${url.host}`
  if (path) {
    return [
      `${base}/.well-known/oauth-authorization-server/${path}`,
      `${base}/.well-known/openid-configuration/${path}`,
      `${base}/${path}/.well-known/openid-configuration`,
    ]
  }
  return [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ]
}

// discoverResourceMetadata finds the protected-resource metadata for an endpoint.
// `challenge` is the WWW-Authenticate header from a 401, when one was seen: the
// spec requires it to take precedence over the well-known guesses.
export async function discoverResourceMetadata(mcpUrl, challenge) {
  const fromChallenge = parseResourceMetadataUrl(challenge)
  const candidates = fromChallenge
    ? [fromChallenge, ...protectedResourceMetadataUrls(mcpUrl)]
    : protectedResourceMetadataUrls(mcpUrl)

  const tried = []
  for (const candidate of candidates) {
    const res = await getJson(candidate)
    tried.push(`${candidate} → ${res.ok ? 'ok' : res.status || res.error}`)
    if (res.ok && res.body) return { ok: true, metadata: res.body, source: candidate, tried }
  }
  return { ok: false, tried }
}

// authorizationServersFrom reads the authorization servers out of
// protected-resource metadata, tolerating two deviations seen in the wild and
// reporting them rather than hiding them.
//
// RFC 9728 defines `authorization_servers`: an array of *issuer identifiers*.
// Some servers send `authorization_server` — singular, a string — and some send
// the metadata document's URL instead of the issuer. Both are usable if you
// notice, and a tool that refuses to proceed teaches the user nothing about why.
export function authorizationServersFrom(metadata) {
  const deviations = []
  let raw = metadata.authorization_servers

  if (!Array.isArray(raw)) {
    if (typeof metadata.authorization_server === 'string') {
      deviations.push(
        'metadata uses "authorization_server" (a string); RFC 9728 defines '
        + '"authorization_servers" as an array of issuer identifiers',
      )
      raw = [metadata.authorization_server]
    } else if (typeof raw === 'string') {
      deviations.push('"authorization_servers" is a string; RFC 9728 defines it as an array')
      raw = [raw]
    } else {
      return { entries: [], deviations }
    }
  }

  const entries = raw.map((value) => {
    // An issuer identifier never contains the well-known path; a metadata
    // document URL does. Telling them apart is what stops the issuer being
    // expanded into /.well-known/…/.well-known/….
    if (value.includes('/.well-known/')) {
      deviations.push(
        `"${value}" is a metadata document URL, not an issuer identifier — RFC 9728 expects the `
        + 'issuer, from which the metadata URL is derived',
      )
      return { metadataUrl: value }
    }
    return { issuer: value }
  })

  return { entries, deviations }
}

// discoverAuthorizationServer fetches an issuer's metadata and validates it.
//
// The issuer check is not optional bookkeeping: metadata served at one host that
// claims to be another host's issuer is the documented attack, and a client that
// accepts it will send credentials to the attacker. So a mismatch is refused.
export async function discoverAuthorizationServer(entry) {
  const tried = []

  // Handed a metadata URL rather than an issuer: fetch it directly, and check the
  // issuer it declares belongs to the same origin. That keeps the property the
  // issuer comparison exists for — metadata from one host cannot claim to speak
  // for another — without rejecting a server whose only sin is naming the
  // document instead of the issuer.
  if (entry.metadataUrl) {
    const res = await getJson(entry.metadataUrl)
    if (!res.ok || !res.body) {
      return { ok: false, tried: [`${entry.metadataUrl} → ${res.status || res.error}`] }
    }
    const declared = res.body.issuer
    if (!declared) {
      return { ok: false, tried: [`${entry.metadataUrl} → refused: declares no issuer`] }
    }
    if (new URL(declared).origin !== new URL(entry.metadataUrl).origin) {
      return {
        ok: false,
        tried: [
          `${entry.metadataUrl} → refused: declares issuer ${JSON.stringify(declared)}, `
          + 'which is a different origin from the document',
        ],
      }
    }
    return { ok: true, metadata: res.body, source: entry.metadataUrl, tried }
  }

  const issuer = entry.issuer
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    const res = await getJson(candidate)
    if (!res.ok || !res.body) {
      tried.push(`${candidate} → ${res.status || res.error}`)
      continue
    }
    const declared = res.body.issuer
    if (declared !== issuer) {
      tried.push(`${candidate} → refused: declares issuer ${JSON.stringify(declared)}, expected ${JSON.stringify(issuer)}`)
      continue
    }
    return { ok: true, metadata: res.body, source: candidate, tried }
  }
  return { ok: false, tried }
}

// chooseAuthMethod picks how this client will authenticate at the token endpoint,
// from what the authorization server says it accepts.
//
// It exists so registration and the token request cannot disagree. RFC 7591 makes
// `token_endpoint_auth_method` a statement about what the client *will* use, so
// registering `client_secret_post` and then sending HTTP Basic is a contradiction
// a strict authorization server is entitled to reject.
// `publicClient` inverts the preference. A native client running the
// authorization_code flow has no secret to keep — RFC 8252 §8.5 says so plainly,
// since a secret shipped in a public package is not a secret — and its security
// comes from PKCE instead. So it asks for `none` where the server offers it, and
// only falls back to a secret-based method for a server that insists on one.
// Getting this backwards is how a public client ends up registered as
// `client_secret_basic` and then unable to authenticate.
export function chooseAuthMethod(asMetadata, { publicClient = false } = {}) {
  const methods = asMetadata?.token_endpoint_auth_methods_supported
  if (!Array.isArray(methods) || methods.length === 0) {
    return publicClient ? 'none' : 'client_secret_basic'
  }
  if (publicClient && methods.includes('none')) return 'none'
  if (methods.includes('client_secret_basic')) return 'client_secret_basic'
  if (methods.includes('client_secret_post')) return 'client_secret_post'
  if (methods.includes('none')) return 'none'
  // Something exotic (private_key_jwt, tls_client_auth). Naming it lets the
  // failure explain itself rather than looking like a bad secret.
  return methods[0]
}

// registerClient performs Dynamic Client Registration (RFC 7591).
//
// What it registers depends on which grant is about to be used, and the two
// declarations are not interchangeable. RFC 7591 treats these fields as promises
// about what the client will do, so a client registered for client_credentials
// with no redirect_uris cannot then visit the authorization endpoint, and one
// registered for authorization_code must name the exact redirect it will come
// back to. Registering the wrong shape produces an `invalid_client` or
// `invalid_redirect_uri` several steps later, where the cause is no longer
// visible.
//
// `redirectUris` therefore has to be known before this is called, which is why
// the loopback receiver is bound first: its port is part of the promise.
export async function registerClient(asMetadata, {
  scope,
  grantTypes = ['client_credentials'],
  redirectUris,
  publicClient = false,
} = {}) {
  const endpoint = asMetadata.registration_endpoint
  if (!endpoint) return { ok: false, reason: 'the authorization server advertises no registration_endpoint' }

  const authMethod = chooseAuthMethod(asMetadata, { publicClient })
  const wantsCode = grantTypes.includes('authorization_code')
  const body = {
    client_name: CLIENT_NAME,
    application_type: 'native',
    grant_types: grantTypes,
    // RFC 7591 defaults an omitted response_types to ["code"], which declares a
    // client that visits the authorization endpoint. So it is stated either way
    // rather than defaulted: ["code"] for the interactive flow, and empty for
    // client_credentials, which never goes near it.
    response_types: wantsCode ? ['code'] : [],
    token_endpoint_auth_method: authMethod,
    ...(redirectUris ? { redirect_uris: redirectUris } : {}),
    ...(scope ? { scope } : {}),
  }

  let res
  let text
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    text = await res.text()
  } catch (err) {
    return { ok: false, reason: `registration endpoint ${endpoint} unreachable: ${err?.cause?.code ?? err.message}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: `registration returned non-JSON (status ${res.status}): ${text.slice(0, 200)}` }
  }
  if (!res.ok) {
    return { ok: false, reason: `registration failed (status ${res.status}): ${JSON.stringify(parsed).slice(0, 300)}` }
  }
  if (!parsed.client_id) {
    return { ok: false, reason: `registration returned no client_id: ${JSON.stringify(parsed).slice(0, 200)}` }
  }
  // The server may register a different method than the one asked for; RFC 7591
  // lets it substitute, and its answer is the one that binds.
  return {
    ok: true,
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
    authMethod: parsed.token_endpoint_auth_method || authMethod,
    raw: parsed,
  }
}

// postToken sends a token request and normalises the answer.
//
// Both grants end here, and both need the same care: an error response is JSON
// with `error`/`error_description` (RFC 6749 §5.2), a body that is not JSON at
// all is a proxy or a login page rather than an authorization server, and
// neither should surface as a thrown exception. The distinction is what turns
// "the flow failed" into something a reader can act on.
async function postToken(endpoint, form, headers) {
  let res
  let text
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body: form })
    text = await res.text()
  } catch (err) {
    return { ok: false, reason: `token endpoint ${endpoint} unreachable: ${err?.cause?.code ?? err.message}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: `token endpoint returned non-JSON (status ${res.status}): ${text.slice(0, 200)}` }
  }
  if (!res.ok || !parsed.access_token) {
    const detail = parsed.error_description || parsed.error || JSON.stringify(parsed).slice(0, 300)
    return { ok: false, reason: `token request failed (status ${res.status}): ${detail}` }
  }
  return { ok: true, accessToken: parsed.access_token, tokenType: parsed.token_type, raw: parsed }
}

// applyClientAuth puts the client's credential where the registered method says
// it goes. One place, so registration and both grants cannot disagree.
//
// `none` is a real method, not a missing one: a public client sends `client_id`
// in the body and nothing else, and adding an empty Basic header for it is what
// makes an authorization server answer `invalid_client`.
function applyClientAuth(form, headers, { clientId, clientSecret, method }) {
  if (clientSecret && method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    return
  }
  form.set('client_id', clientId)
  if (clientSecret) form.set('client_secret', clientSecret)
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }

// requestToken performs the client_credentials grant, carrying the RFC 8707
// resource parameter the spec requires so the token is bound to this MCP server
// as its audience.
export async function requestToken(asMetadata, { clientId, clientSecret, resource, scope, authMethod }) {
  const endpoint = asMetadata.token_endpoint
  if (!endpoint) return { ok: false, reason: 'the authorization server advertises no token_endpoint' }

  const form = new URLSearchParams({ grant_type: 'client_credentials', resource })
  if (scope) form.set('scope', scope)

  const headers = { ...FORM_HEADERS }
  // Whatever the client registered as, or what the server accepts for a static
  // client. The two paths agree because both go through chooseAuthMethod.
  applyClientAuth(form, headers, {
    clientId,
    clientSecret,
    method: authMethod || chooseAuthMethod(asMetadata),
  })

  return postToken(endpoint, form, headers)
}

// exchangeCode redeems an authorization code for a token (RFC 6749 §4.1.3, with
// RFC 7636 §4.5).
//
// Three parameters here are easy to leave off and each has a specific reason to
// be present:
//
//   code_verifier — the other half of the PKCE challenge. Omitting it turns the
//     flow back into one where an intercepted code is redeemable.
//   redirect_uri  — required, byte-for-byte, because it was in the authorization
//     request. This is a binding check, not a routing hint; nothing is redirected
//     at this point.
//   resource      — RFC 8707 again, and required on the token request as well as
//     the authorization request. Without it an authorization server that issues
//     audience-restricted tokens has nothing to restrict this one to, and the MCP
//     server is entitled to reject a token that is not addressed to it.
export async function exchangeCode(asMetadata, {
  code, codeVerifier, redirectUri, clientId, clientSecret, resource, authMethod,
}) {
  const endpoint = asMetadata.token_endpoint
  if (!endpoint) return { ok: false, reason: 'the authorization server advertises no token_endpoint' }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  })
  if (resource) form.set('resource', resource)

  const headers = { ...FORM_HEADERS }
  applyClientAuth(form, headers, {
    clientId,
    clientSecret,
    method: authMethod || chooseAuthMethod(asMetadata, { publicClient: !clientSecret }),
  })

  return postToken(endpoint, form, headers)
}

// supportsClientCredentials reports whether the machine-to-machine grant is on
// offer. Absent metadata is treated as "try it": some servers omit the field.
export function supportsClientCredentials(asMetadata) {
  const grants = asMetadata.grant_types_supported
  if (!Array.isArray(grants)) return true
  return grants.includes('client_credentials')
}

// supportsAuthorizationCode reports whether the interactive grant is on offer.
//
// The authorization_endpoint is checked as well as the grant, because a server
// that names the grant but no endpoint to start it at cannot actually run the
// flow, and finding that out after opening somebody's browser is too late.
export function supportsAuthorizationCode(asMetadata) {
  if (!asMetadata.authorization_endpoint) return false
  const grants = asMetadata.grant_types_supported
  if (!Array.isArray(grants)) return true
  return grants.includes('authorization_code')
}

// isLocal recognises loopback targets, where plain http is a test fixture rather
// than a mistake.
function isLocal(url) {
  const host = new URL(url).hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

// probeChallenge asks the endpoint for a 401 so its WWW-Authenticate can be read.
// A cheap, harmless request: server/discover needs no session and no version.
//
// Whatever credentials the caller already configured are sent with it. A token in
// the URL's query string, or an Authorization header supplied through --header,
// authenticates this probe too — so the endpoint answers 200 and no OAuth flow is
// started. Probing bare would manufacture a 401 and go off registering a client
// for a caller who had already provided credentials.
export async function probeChallenge(mcpUrl, headers = {}) {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'auth-probe', method: 'server/discover' }),
    })
    await res.text()
    return { status: res.status, challenge: res.headers.get('www-authenticate') }
  } catch (err) {
    return { status: 0, error: err?.message || String(err) }
  }
}

// interactiveGrant runs the authorization_code flow with a loopback redirect and
// PKCE — the same shape an MCP client uses when a server needs a human to sign
// in, and the only way to get a token out of an authorization server that offers
// no machine grant.
//
// The order of the first two steps is the part worth being deliberate about. The
// receiver binds first, because the port it lands on is part of the redirect URI,
// and the redirect URI is what gets registered. Registering first would mean
// guessing a port and then hoping it was free.
async function interactiveGrant(asMetadata, {
  resource,
  clientId,
  clientSecret,
  scope,
  allowRegistration,
  redirectHost,
  redirectPort,
  timeoutMs,
  launchBrowser,
  log,
}) {
  const pkceChoice = chooseCodeChallengeMethod(asMetadata)
  if (!pkceChoice.ok) return { ok: false, reason: pkceChoice.reason }
  if (!pkceChoice.advertised) {
    // Not a blocker, but a conformance runner noticing it is the point of a
    // conformance runner: RFC 8414 §2 and OAuth 2.1 both expect this advertised.
    log('note: the authorization server advertises no code_challenge_methods_supported; attempting S256, which OAuth 2.1 requires of it')
  }

  let receiver
  try {
    receiver = await startReceiver({ host: redirectHost, port: redirectPort })
  } catch (err) {
    const detail = err?.code === 'EADDRINUSE'
      ? `port ${redirectPort} is already in use`
      : err?.message || String(err)
    return { ok: false, reason: `could not bind the loopback redirect receiver: ${detail}` }
  }

  try {
    let id = clientId
    let secret = clientSecret
    let authMethod
    if (!id) {
      if (!allowRegistration) {
        return { ok: false, reason: 'no client credentials given and registration is disabled (--no-register)' }
      }
      log(`no client credentials given; registering a client with ${asMetadata.registration_endpoint} for redirect ${receiver.redirectUri}`)
      const registered = await registerClient(asMetadata, {
        scope,
        grantTypes: ['authorization_code'],
        redirectUris: [receiver.redirectUri],
        // No secret to protect: this client runs on the operator's machine and
        // is published to npm. PKCE is what secures it.
        publicClient: true,
      })
      if (!registered.ok) return { ok: false, reason: registered.reason }
      id = registered.clientId
      secret = registered.clientSecret
      authMethod = registered.authMethod
      log(`registered client_id ${id} using ${authMethod}`)
    }

    const { verifier, challenge, method } = pkcePair()
    const state = newState()
    const authUrl = buildAuthorizationUrl(asMetadata, {
      clientId: id,
      redirectUri: receiver.redirectUri,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: method,
      scope,
      resource,
    })

    // Printed whether or not the browser opens. Over SSH or in a container there
    // is nothing to open, and a tool that only opened a browser would look like
    // it had hung; a URL on the terminal is always usable.
    log('waiting for you to authorize this run in a browser. If one did not open, visit:')
    log(`  ${authUrl}`)
    if (launchBrowser) openInBrowser(authUrl)

    const redirect = await receiver.waitForRedirect({ timeoutMs, state })
    if (!redirect.ok) return { ok: false, reason: redirect.reason }
    log('authorization code received; exchanging it for a token')

    const token = await exchangeCode(asMetadata, {
      code: redirect.code,
      codeVerifier: verifier,
      redirectUri: receiver.redirectUri,
      clientId: id,
      clientSecret: secret,
      resource,
      authMethod,
    })
    if (!token.ok) return { ok: false, reason: token.reason }
    return { ok: true, accessToken: token.accessToken, clientId: id }
  } finally {
    // The receiver is a listening socket on the operator's machine. It closes on
    // every path out of here, including a registration failure three steps
    // before it would have been used.
    await receiver.close()
  }
}

// resolveScope decides what to ask for when the caller named nothing.
//
// Only used for the interactive grant, and only from the protected-resource
// metadata. RFC 9728 lets a resource publish the scopes that mean something to
// it, and an authorization server running a consent screen frequently insists on
// a scope; asking for the resource's own published set is the closest thing to a
// correct default. It is not applied to client_credentials, where the current
// behaviour of sending only what was asked for already works and a silent change
// would be a change of behaviour for existing runs.
function resolveScope(explicit, prmMetadata, log) {
  if (explicit) return explicit
  const supported = prmMetadata?.scopes_supported
  if (!Array.isArray(supported) || supported.length === 0) return undefined
  const scope = supported.join(' ')
  log(`no --scope given; requesting the scopes the resource publishes: ${scope}`)
  return scope
}

// obtainToken walks the whole chain and returns a bearer token, or an explanation
// of where it stopped. `log` receives a line per step: registering a client
// creates state on someone else's authorization server, and the interactive grant
// opens a browser, so none of this should happen silently.
//
// `interactive` is 'auto' | 'always' | 'never'. The caller resolves 'auto' before
// calling — whether there is a terminal to prompt at is a fact about the process,
// not about OAuth.
export async function obtainToken({
  mcpUrl,
  clientId,
  clientSecret,
  scope,
  allowRegistration = true,
  interactive = 'never',
  redirectHost = '127.0.0.1',
  redirectPort = 0,
  timeoutMs = 180_000,
  launchBrowser = true,
  challenge,
  log = () => {},
}) {
  const resource = canonicalResource(mcpUrl)

  if (!isLocal(mcpUrl) && new URL(mcpUrl).protocol !== 'https:') {
    log('warning: this endpoint is not https, so the token being negotiated crosses the network in clear text')
  }

  const prm = await discoverResourceMetadata(mcpUrl, challenge)
  if (!prm.ok) {
    return { ok: false, reason: `no protected-resource metadata found. Tried:\n  ${prm.tried.join('\n  ')}` }
  }
  log(`found protected-resource metadata at ${prm.source}`)

  const { entries, deviations } = authorizationServersFrom(prm.metadata)
  for (const note of deviations) log(`note: ${note}`)
  if (entries.length === 0) {
    return {
      ok: false,
      reason: `${prm.source} names no authorization server `
        + '(expected "authorization_servers": ["<issuer>"])',
    }
  }

  const failures = []
  for (const entry of entries) {
    const label = entry.issuer ?? entry.metadataUrl
    const as = await discoverAuthorizationServer(entry)
    if (!as.ok) {
      failures.push(`${label}: no usable metadata\n    ${as.tried.join('\n    ')}`)
      continue
    }
    log(`found authorization server metadata at ${as.source}`)

    // Which grant to run.
    //
    // client_credentials first, because it is the one that works unattended: a
    // CI run that could have got a token without a human should not stop to ask
    // for one. --interactive overrides that ordering, since "check that the
    // browser flow works" is a legitimate thing to want from a conformance tool
    // even where a machine grant exists.
    const canMachine = supportsClientCredentials(as.metadata)
    const canBrowser = supportsAuthorizationCode(as.metadata) && interactive !== 'never'
    const useBrowser = canBrowser && (interactive === 'always' || !canMachine)

    if (useBrowser) {
      log('using the authorization_code grant with a loopback redirect and PKCE')
      const result = await interactiveGrant(as.metadata, {
        resource,
        clientId,
        clientSecret,
        scope: resolveScope(scope, prm.metadata, log),
        allowRegistration,
        redirectHost,
        redirectPort,
        timeoutMs,
        launchBrowser,
        log,
      })
      if (!result.ok) {
        failures.push(`${label}: ${result.reason}`)
        continue
      }
      log(`obtained an access token for resource ${resource}`)
      return { ok: true, accessToken: result.accessToken, issuer: as.metadata.issuer, clientId: result.clientId }
    }

    if (!canMachine) {
      // Naming the alternative precisely matters here. This is no longer a dead
      // end — it is a flow that needs a person, and the message has to say which
      // switch turns it on and why it was not thrown automatically.
      failures.push(
        `${label}: advertises grant_types_supported `
        + `${JSON.stringify(as.metadata.grant_types_supported)} — no client_credentials. `
        + (supportsAuthorizationCode(as.metadata)
          ? 'It does offer authorization_code, which needs a browser and a person: '
            + 'rerun with --interactive (this run had no terminal to ask at, or was '
            + 'given --no-interactive). Or pass a token with --token.'
          : 'No grant here can be run without a browser. Pass a token with --token.'),
      )
      continue
    }

    let id = clientId
    let secret = clientSecret
    let authMethod
    if (!id) {
      if (!allowRegistration) {
        failures.push(`${label}: no client credentials given and registration is disabled (--no-register)`)
        continue
      }
      log(`no client credentials given; registering a client with ${as.metadata.registration_endpoint}`)
      const registered = await registerClient(as.metadata, { scope })
      if (!registered.ok) {
        failures.push(`${label}: ${registered.reason}`)
        continue
      }
      id = registered.clientId
      secret = registered.clientSecret
      authMethod = registered.authMethod
      log(`registered client_id ${id} using ${authMethod}`)
    }

    const token = await requestToken(as.metadata, { clientId: id, clientSecret: secret, resource, scope, authMethod })
    if (!token.ok) {
      failures.push(`${label}: ${token.reason}`)
      continue
    }
    log(`obtained an access token for resource ${resource}`)
    return { ok: true, accessToken: token.accessToken, issuer: as.metadata.issuer, clientId: id }
  }

  return { ok: false, reason: `could not obtain a token.\n  ${failures.join('\n  ')}` }
}
