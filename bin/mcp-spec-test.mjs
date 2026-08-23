#!/usr/bin/env node
// The command-line entry point.
//
//   npx @hasmcp/mcp-spec-test@latest -u https://example.com/mcp -t <token>
//   npx @hasmcp/mcp-spec-test@latest -c "npx -y @modelcontextprotocol/server-everything"
//
// Every flag has an environment-variable twin, and flags win over the
// environment, so the same run is expressible either way — a flag for a one-off
// check, env vars for CI where a token should not appear in a command line or
// process list.
//
// The suite itself is plain node:test, so this wrapper does one thing: turn
// arguments into the environment the tests read, then run them under the
// conformance reporter.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// flag → environment variable. Long and short forms both land here.
const FLAGS = {
  '--url': 'MCP_URL',
  '-u': 'MCP_URL',
  '--command': 'MCP_COMMAND',
  '-c': 'MCP_COMMAND',
  '--token': 'MCP_TOKEN',
  '-t': 'MCP_TOKEN',
  '--auth-mode': 'MCP_AUTH_MODE',
  '--auth-header': 'MCP_AUTH_HEADER',
  '--auth-scheme': 'MCP_AUTH_SCHEME',
  '--auth-query-param': 'MCP_AUTH_QUERY_PARAM',
  '--header': 'MCP_EXTRA_HEADERS',
  '-H': 'MCP_EXTRA_HEADERS',
  '--spec-version': 'MCP_SPEC_VERSION',
  '--spec-path': 'MCP_SPEC_PATH',
  '--default-version': 'MCP_SERVER_DEFAULT_VERSION',
  '--stream-budget-ms': 'MCP_STREAM_BUDGET_MS',
  '--tool-args': 'MCP_TOOL_ARGS',
  '--prompt-args': 'MCP_PROMPT_ARGS',
  '--resource-sample': 'MCP_RESOURCE_SAMPLE',
  '--page-limit': 'MCP_PAGE_LIMIT',
  '--rate-limit': 'MCP_RATE_LIMIT',
  '--retry-budget-ms': 'MCP_RETRY_BUDGET_MS',
  '--client-id': 'MCP_CLIENT_ID',
  '--client-secret': 'MCP_CLIENT_SECRET',
  '--scope': 'MCP_SCOPE',
  '--redirect-host': 'MCP_REDIRECT_HOST',
  '--redirect-port': 'MCP_REDIRECT_PORT',
  '--auth-timeout': 'MCP_AUTH_TIMEOUT_MS',
}

const USAGE = `
${pkg.name} ${pkg.version} — conformance test any MCP server against the current spec

Usage
  npx ${pkg.name}@latest -u <url> [options]
  npx ${pkg.name}@latest -c "<command to spawn>" [options]

Target (one is required)
  -u, --url <url>              Streamable HTTP endpoint            [MCP_URL]
  -c, --command <cmd>          command to spawn and speak stdio to [MCP_COMMAND]

Credentials
  -t, --token <token>          bearer token                        [MCP_TOKEN]
      --auth-mode <mode>       header | query | none (default header)
                                                                   [MCP_AUTH_MODE]
      --auth-header <name>     header carrying the token (default authorization)
                                                                   [MCP_AUTH_HEADER]
      --auth-scheme <scheme>   token prefix (default "Bearer"; "" for a bare token)
                                                                   [MCP_AUTH_SCHEME]
      --auth-query-param <k>   query parameter in query mode (default token)
                                                                   [MCP_AUTH_QUERY_PARAM]
  -H, --header <list>          extra headers, "k: v, k2: v2"       [MCP_EXTRA_HEADERS]

OAuth 2.1, when the endpoint requires it
      --client-id <id>         OAuth client id                     [MCP_CLIENT_ID]
      --client-secret <secret> OAuth client secret             [MCP_CLIENT_SECRET]
      --scope <scope>          scope to request                        [MCP_SCOPE]
      --no-register            do not register a client dynamically, even if the
                               authorization server offers it   [MCP_NO_REGISTER]
      --interactive            sign in through a browser (authorization_code +
                               PKCE, loopback redirect) even where a machine
                               grant exists            [MCP_OAUTH_INTERACTIVE=always]
      --no-interactive         never open a browser; fail instead
                                                       [MCP_OAUTH_INTERACTIVE=never]
      --no-browser             print the authorization URL rather than launching
                               a browser, for SSH and containers  [MCP_NO_BROWSER]
      --redirect-host <host>   loopback host for the redirect (default 127.0.0.1;
                               use localhost for a server that only allows it)
                                                                 [MCP_REDIRECT_HOST]
      --redirect-port <n>      pin the redirect port instead of taking a free one,
                               for a server that will not allow a varying port
                                                                 [MCP_REDIRECT_PORT]
      --auth-timeout <ms>      how long to wait for the browser redirect
                               (default 180000)               [MCP_AUTH_TIMEOUT_MS]

  With no --token, an endpoint that answers 401 is discovered per the spec:
  WWW-Authenticate, then protected-resource metadata, then the authorization
  server. Client credentials are used if given; otherwise a client is registered
  dynamically when the server supports it. Every step is printed.

  Which grant runs: client_credentials where the authorization server offers it,
  since that needs nobody present. Where it does not — many servers only do
  authorization_code — a browser opens and you sign in, but only when there is a
  terminal to notice it and CI is not set. --interactive and --no-interactive
  decide it outright.

Suite
      --spec-version <date>    revision to test; one of the supported window
                               (default 2026-07-28)                [MCP_SPEC_VERSION]
      --spec-path <file>       schema.json to assert against, instead of the
                               vendored copy                       [MCP_SPEC_PATH]
      --default-version <date> the version the server negotiates for a client
                               that declares none; probed if omitted
                                                                   [MCP_SERVER_DEFAULT_VERSION]
      --stream-budget-ms <ms>  how long streaming cases wait (default 4000)
                                                                   [MCP_STREAM_BUDGET_MS]
      --rate-limit <n>         pace requests to at most n per minute, for targets
                               that rate-limit. Copy the number from the server's
                               own limit (e.g. 60 for 60-per-60s). Also runs the
                               test files one at a time, since otherwise each
                               would pace itself independently
                                                                   [MCP_RATE_LIMIT]
      --retry-budget-ms <ms>   how long to wait out a rate limit before reporting
                               the case unverified (default 60000, 0 disables)
                                                                   [MCP_RETRY_BUDGET_MS]

Opting in to calls the suite will not guess at
      --tool-args <json|@file> arguments per tool, '{"search":{"query":"x"}}',
                               or @path to a file containing that JSON. Without
                               this, tools with required arguments are skipped
                               rather than called with invented values
                                                                   [MCP_TOOL_ARGS]
      --prompt-args <json|@file>
                               arguments per prompt, same shape   [MCP_PROMPT_ARGS]
      --resource-sample <n>    how many listed resources to read (default 5)
                                                                   [MCP_RESOURCE_SAMPLE]
      --page-limit <n>         pages to follow before calling pagination broken
                               (default 10)                        [MCP_PAGE_LIMIT]
      --only <pattern>         run only test files matching a substring
      --verbose                also print the target's own stderr    [MCP_VERBOSE]
      --tap                    raw TAP instead of the report, for CI parsing
      --disable-telemetry=1    do not send the anonymous usage counts described
                               in README.md          [MCP_DISABLE_TELEMETRY=1]
  -h, --help                   this message
  -v, --version                print the version

Supported revisions: 2026-07-28, 2025-11-25. Only these two are reasoned about;
an older revision a server advertises is reported as out of scope, not judged.

Flags override the environment, so either style works and CI can keep the token
out of the process list.

Exit code is 0 when nothing failed. Skipped cases do not fail the run, but they
are listed as NOT VERIFIED — a skip is not a pass.
`

const env = { ...process.env }
let only = null
let tap = false
const argv = process.argv.slice(2)

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]

  if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  if (arg === '-v' || arg === '--version') {
    process.stdout.write(`${pkg.version}\n`)
    process.exit(0)
  }
  if (arg === '--no-register') {
    env.MCP_NO_REGISTER = '1'
    continue
  }
  if (arg === '--interactive') {
    env.MCP_OAUTH_INTERACTIVE = 'always'
    continue
  }
  if (arg === '--no-interactive') {
    env.MCP_OAUTH_INTERACTIVE = 'never'
    continue
  }
  if (arg === '--no-browser') {
    env.MCP_NO_BROWSER = '1'
    continue
  }
  if (arg === '--verbose') {
    env.MCP_VERBOSE = '1'
    continue
  }
  if (arg === '--tap') {
    tap = true
    continue
  }
  // Accepts --disable-telemetry and --disable-telemetry=1 alike. Handled here
  // rather than in FLAGS because the bare form takes no value, and a FLAGS entry
  // would eat the next argument.
  if (arg === '--disable-telemetry' || arg.startsWith('--disable-telemetry=')) {
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '1'
    env.MCP_DISABLE_TELEMETRY = value === '0' || value === 'false' ? '0' : '1'
    continue
  }
  if (arg === '--only') {
    only = argv[++i]
    continue
  }

  // --url=value as well as --url value, since both are muscle memory.
  const eq = arg.indexOf('=')
  const name = eq === -1 ? arg : arg.slice(0, eq)
  const key = FLAGS[name]
  if (!key) {
    process.stderr.write(`unknown option: ${arg}\n${USAGE}\n`)
    process.exit(2)
  }
  const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
  if (value === undefined) {
    process.stderr.write(`${name} needs a value\n`)
    process.exit(2)
  }
  env[key] = value
}

// `@path` argument files are resolved here, against the shell's working
// directory, because the tests run with cwd set to the package root — a relative
// path would otherwise resolve somewhere inside node_modules. Reading them now
// also means a bad path is reported once, before the run, instead of identically
// inside every test file that needs it.
for (const key of ['MCP_TOOL_ARGS', 'MCP_PROMPT_ARGS']) {
  const value = env[key]
  if (!value?.startsWith('@')) continue

  const path = value.slice(1)
  if (!path) {
    process.stderr.write(`${key} is "@" with no path after it\n`)
    process.exit(2)
  }

  const absolute = resolve(process.cwd(), path)
  try {
    const parsed = JSON.parse(readFileSync(absolute, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      process.stderr.write(`${absolute} must contain a JSON object keyed by name\n`)
      process.exit(2)
    }
  } catch (err) {
    process.stderr.write(`${key}: cannot use ${absolute} — ${err.message}\n`)
    process.exit(2)
  }
  env[key] = `@${absolute}`
}

if (!env.MCP_URL && !env.MCP_COMMAND) {
  process.stderr.write(`no target: pass -u <url> or -c "<command>" (or set MCP_URL / MCP_COMMAND)\n${USAGE}\n`)
  process.exit(2)
}
if (env.MCP_URL && env.MCP_COMMAND) {
  process.stderr.write('pass either a url or a command, not both — they select different transports\n')
  process.exit(2)
}

// parseHeaderList reads the "k: v, k2: v2" form used by --header.
function parseHeaderList(raw) {
  if (!raw) return {}
  const out = {}
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':')
    if (idx === -1) continue
    out[pair.slice(0, idx).trim().toLowerCase()] = pair.slice(idx + 1).trim()
  }
  return out
}

// resolveInteractive decides whether a browser may be opened.
//
// The default is 'auto', and what it resolves to is a fact about the process
// rather than about OAuth: a browser flow needs somebody sitting there. So it
// requires a terminal on stderr — where every line of the flow is printed,
// including the URL to visit — and it stands down when CI is set, because a
// build agent has no browser and an unattended job that waited three minutes for
// a redirect that can never arrive is worse than one that fails immediately with
// a reason.
//
// Both can be overridden, since neither heuristic is always right: a developer
// piping output to a file still has a browser, and a self-hosted runner with CI
// set might legitimately be driven by hand.
function resolveInteractive() {
  const explicit = env.MCP_OAUTH_INTERACTIVE
  if (explicit === 'always' || explicit === 'never') return explicit
  if (!process.stderr.isTTY) return 'never'
  if (env.CI) return 'never'
  return 'auto'
}

// Obtain a bearer token when the endpoint wants one and none was supplied.
//
// Done here rather than in the tests for the same reason as revision detection:
// it happens once, and the test processes stay concerned with the protocol rather
// than with how a credential was acquired.
async function maybeAuthenticate() {
  if (env.MCP_TOKEN || env.MCP_COMMAND || !env.MCP_URL) return

  const oauth = await import(`file://${join(root, 'lib', 'oauth.mjs')}`)

  // Send whatever the caller already configured: a `?token=` already in the URL,
  // and any headers from --header. If those are enough, the endpoint answers and
  // there is nothing to negotiate.
  //
  // Parsed here rather than imported from lib/env.mjs on purpose. That module
  // computes its exports once, at import time, from process.env — so importing it
  // before the flag-derived values are in place would freeze the wrong ones and
  // the cached copy would still be wrong later, when a token from this flow
  // matters. It stays unimported until everything it reads is settled.
  const probe = await oauth.probeChallenge(env.MCP_URL, parseHeaderList(env.MCP_EXTRA_HEADERS))
  if (probe.status !== 401) return // not an authenticated endpoint, or already open

  process.stderr.write('endpoint returned 401; discovering OAuth configuration\n')
  let result
  try {
    result = await oauth.obtainToken({
      mcpUrl: env.MCP_URL,
      clientId: env.MCP_CLIENT_ID,
      clientSecret: env.MCP_CLIENT_SECRET,
      scope: env.MCP_SCOPE,
      allowRegistration: env.MCP_NO_REGISTER !== '1',
      interactive: resolveInteractive(),
      redirectHost: env.MCP_REDIRECT_HOST || '127.0.0.1',
      redirectPort: Number(env.MCP_REDIRECT_PORT) || 0,
      timeoutMs: Number(env.MCP_AUTH_TIMEOUT_MS) || 180_000,
      launchBrowser: env.MCP_NO_BROWSER !== '1',
      challenge: probe.challenge,
      log: (line) => process.stderr.write(`  ${line}\n`),
    })
  } catch (err) {
    // Belt and braces: a failure to authenticate must not become a crash, since
    // the run can still proceed and report every case as unverified.
    result = { ok: false, reason: err?.message || String(err) }
  }

  if (!result.ok) {
    // Not fatal: the run continues and every case reports itself unverified with
    // the endpoint's own rejection, which is more informative than this tool
    // deciding the run is over.
    process.stderr.write(`could not authenticate: ${result.reason}\n`)
    return
  }
  env.MCP_TOKEN = result.accessToken
  // A token from this flow is a standard OAuth bearer, whatever the endpoint's
  // other credential conventions are.
  env.MCP_AUTH_MODE = 'header'
  env.MCP_AUTH_HEADER = 'authorization'
  env.MCP_AUTH_SCHEME = 'Bearer'
}

await maybeAuthenticate()

// Pick the revision to test from what the server actually serves.
//
// Without this, pointing the tool at a server that speaks an older revision
// reports almost nothing: the capability cases assert against the schema of the
// revision under test, and those requirements differ — ListToolsResult requires
// resultType/ttlMs/cacheScope in 2026-07-28 and only `tools` before it — so
// running them against a server on another revision would fail it for not
// implementing something it never claimed. Skipping is right, but "28 not
// verified" is a useless answer to "is my server conformant".
//
// So the server is asked first, and the newest revision it offers that this
// suite supports is the one tested. An explicit --spec-version always wins:
// "check my server against 2026-07-28" is a legitimate question, and the answer
// to it should not silently become a different question.
async function detectRevision() {
  const previous = { ...process.env }
  Object.assign(process.env, env)
  try {
    const { SUPPORTED_REVISIONS } = await import(`file://${join(root, 'lib', 'env.mjs')}`)
    const { transport, shutdown } = await import(`file://${join(root, 'lib', 'transport.mjs')}`)
    const { throttled } = await import(`file://${join(root, 'lib', 'rpc.mjs')}`)
    try {
      const { versions, via, name } = await askServer(transport, SUPPORTED_REVISIONS, throttled)
      if (!versions.length) return name ? { revision: null, via: null, name } : null
      // Revision ids are ISO dates, so the newest supported one sorts last.
      const pick = versions.filter((v) => SUPPORTED_REVISIONS.includes(v)).sort().at(-1)
      return pick ? { revision: pick, via, name } : { revision: null, via: null, name }
    } finally {
      shutdown()
    }
  } catch {
    // An unreachable or unusual target is the test run's problem to report, not
    // the pre-flight's. Fall through to the default revision.
    return null
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

// askServer asks server/discover, which lists every servable revision, and falls
// back to initialize only when discover is genuinely absent.
//
// The line that matters is between "the server answered and cannot serve
// discover" and "we could not ask it". The first is a fact to act on: try the
// handshake, which is how a server without discover reports its version. The
// second is not — a rate limit or a transport blip used to fall through to the
// handshake, which reports a single, older negotiated version, and the run would
// then test that revision and publish a confident verdict for it. Testing
// something other than what the server offers is worse than detecting nothing.
async function askServer(transport, revisions, throttled) {
  const discover = await transport.send(
    { jsonrpc: '2.0', id: 'preflight-discover', method: 'server/discover' },
    { headers: {} },
  )

  // Picked up in passing, never asked for on its own: telemetry must not add a
  // request to the target. serverInfo moved into result _meta when the handshake
  // went away, so both places are checked.
  const discovered = discover.body?.result
  const name = discovered?.serverInfo?.name
    ?? discovered?._meta?.['io.modelcontextprotocol/serverInfo']?.name

  const listed = discovered?.supportedVersions
  if (Array.isArray(listed) && listed.length) return { versions: listed, via: 'server/discover', name }

  // No answer, or an answer that only says "not right now": nothing was learned.
  if (throttled(discover) || !discover.body?.error) return { versions: [], via: null, name }

  const init = await transport.send({
    jsonrpc: '2.0',
    id: 'preflight-initialize',
    method: 'initialize',
    params: {
      protocolVersion: revisions.at(-1),
      capabilities: {},
      clientInfo: { name: 'mcp-spec-test', version: pkg.version },
    },
  }, { headers: {} })
  const negotiated = init.body?.result?.protocolVersion
  const handshakeName = name ?? init.body?.result?.serverInfo?.name
  return negotiated
    ? { versions: [negotiated], via: 'the handshake', name: handshakeName }
    : { versions: [], via: null, name: handshakeName }
}

// The pre-flight runs even when --spec-version settles the revision, because it
// is also where the server's announced name is learned, and a run that skipped it
// reported no serverId at all. One request buys that; an explicit --spec-version
// still wins outright, so what gets tested is unchanged either way.
const detected = await detectRevision()

// Hashed in the reporter, never sent in the clear; see the telemetry section of
// README.md. Absent when the server announced no name — an endpoint answering 401
// tells us nothing to hash.
if (detected?.name) env.MCP_SERVER_NAME = detected.name

if (!env.MCP_SPEC_VERSION) {
  if (detected?.revision) {
    env.MCP_SPEC_VERSION = detected.revision
    process.stderr.write(
      `testing ${detected.revision} — the newest supported revision this server offers, per ${detected.via}\n`,
    )
  } else {
    // Saying so matters: the run continues against the newest vendored revision,
    // and a reader has to know the choice was a default rather than the server's
    // answer.
    process.stderr.write(
      'could not establish which revisions this server offers; '
      + 'testing the newest supported one — pass --spec-version to be explicit\n',
    )
  }
}

// Non-recursive on purpose. tests/ holds the conformance cases and tests/unit/
// holds this package's own tests, and only the first kind belongs in somebody's
// conformance report — a user asking "is my server conformant" should not be
// shown a section proving that our PKCE implementation hashes correctly.
const pattern = only ? `tests/*${only}*.test.mjs` : 'tests/*.test.mjs'
const args = ['--test']

// Pacing is per process and node:test gives each file its own, so a limit only
// holds if the files run one at a time. Without this, the requests-per-minute
// number would silently mean that many per file.
if (Number(env.MCP_RATE_LIMIT) > 0) args.push('--test-concurrency=1')
args.push(tap ? '--test-reporter=tap' : `--test-reporter=${join(root, 'lib', 'reporter.mjs')}`)
args.push(pattern)

const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
