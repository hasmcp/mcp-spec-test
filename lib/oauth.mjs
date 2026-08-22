// OAuth 2.1 for a machine client.
//
// The spec's discovery chain is prescriptive, so this implements it rather than
// improvising: a 401's WWW-Authenticate names the protected-resource metadata,
// that names the authorization servers, and each server's metadata names the
// token and registration endpoints. Where the client has no credentials and the
// authorization server offers Dynamic Client Registration, it registers itself —
// which is the fallback the spec prescribes, not a shortcut around it.
//
// One thing this deliberately cannot do is an interactive flow. A conformance
// runner has no browser and no user, so it uses the client_credentials grant. An
// authorization server that only issues tokens through authorization_code is a
// dead end for automation, and saying so plainly is more useful than a timeout.

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

async function getJson(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } })
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

// registerClient performs Dynamic Client Registration (RFC 7591).
//
// application_type is required by the spec. A conformance runner is not a browser
// app and has no redirect to return to, so it registers as a native client asking
// only for client_credentials.
export async function registerClient(asMetadata, { scope } = {}) {
  const endpoint = asMetadata.registration_endpoint
  if (!endpoint) return { ok: false, reason: 'the authorization server advertises no registration_endpoint' }

  const body = {
    client_name: CLIENT_NAME,
    application_type: 'native',
    grant_types: ['client_credentials'],
    response_types: [],
    token_endpoint_auth_method: 'client_secret_post',
    ...(scope ? { scope } : {}),
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
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
  return { ok: true, clientId: parsed.client_id, clientSecret: parsed.client_secret, raw: parsed }
}

// requestToken performs the client_credentials grant, carrying the RFC 8707
// resource parameter the spec requires so the token is bound to this MCP server
// as its audience.
export async function requestToken(asMetadata, { clientId, clientSecret, resource, scope }) {
  const endpoint = asMetadata.token_endpoint
  if (!endpoint) return { ok: false, reason: 'the authorization server advertises no token_endpoint' }

  const form = new URLSearchParams({ grant_type: 'client_credentials', resource })
  if (scope) form.set('scope', scope)

  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }

  // Basic auth is the more widely accepted form, but an authorization server may
  // advertise only the body form, so follow what it says it accepts.
  const methods = asMetadata.token_endpoint_auth_methods_supported
  const preferBasic = !Array.isArray(methods) || methods.includes('client_secret_basic')
  if (clientSecret && preferBasic) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  } else {
    form.set('client_id', clientId)
    if (clientSecret) form.set('client_secret', clientSecret)
  }

  const res = await fetch(endpoint, { method: 'POST', headers, body: form })
  const text = await res.text()
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

// supportsClientCredentials reports whether the grant this tool needs is on offer.
// Absent metadata is treated as "try it": some servers omit the field.
export function supportsClientCredentials(asMetadata) {
  const grants = asMetadata.grant_types_supported
  if (!Array.isArray(grants)) return true
  return grants.includes('client_credentials')
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

// obtainToken walks the whole chain and returns a bearer token, or an explanation
// of where it stopped. `log` receives a line per step: registering a client
// creates state on someone else's authorization server, so none of this should
// happen silently.
export async function obtainToken({ mcpUrl, clientId, clientSecret, scope, allowRegistration = true, challenge, log = () => {} }) {
  const resource = canonicalResource(mcpUrl)

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

    if (!supportsClientCredentials(as.metadata)) {
      // Worth naming precisely: this is not a bug to work around, it is an
      // authorization server that only issues tokens to a human at a browser.
      failures.push(
        `${label}: advertises grant_types_supported `
        + `${JSON.stringify(as.metadata.grant_types_supported)} — no client_credentials, so a `
        + 'runner with no browser cannot obtain a token. Pass one with --token.',
      )
      continue
    }

    let id = clientId
    let secret = clientSecret
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
      log(`registered client_id ${id}`)
    }

    const token = await requestToken(as.metadata, { clientId: id, clientSecret: secret, resource, scope })
    if (!token.ok) {
      failures.push(`${label}: ${token.reason}`)
      continue
    }
    log(`obtained an access token for resource ${resource}`)
    return { ok: true, accessToken: token.accessToken, issuer: as.metadata.issuer, clientId: id }
  }

  return { ok: false, reason: `could not obtain a token.\n  ${failures.join('\n  ')}` }
}
