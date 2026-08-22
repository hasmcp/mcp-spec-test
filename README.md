# @hasmcp/mcp-spec-test

A black-box conformance suite for **any** MCP server. It speaks the protocol over
the wire and nothing else — no plugin, no instrumentation, no knowledge of the
implementation — so the same suite runs against a local process, a staging
deployment or somebody else's hosted endpoint without modification.

It supports the **two most recent spec revisions only** — currently `2026-07-28`
and `2025-11-25` — and always tracks the newest one. Anything older is reported
as out of scope rather than judged. See [Supported revisions](#supported-revisions).

```bash
npx @hasmcp/mcp-spec-test@latest -u https://mcp.example.com/mcp -t <token>
npx @hasmcp/mcp-spec-test@latest -c "npx -y @modelcontextprotocol/server-everything"
```

It reports what the server does, where it deviates from the spec, and — as its
own section — what could not be checked:

```
MCP 2026-07-28 conformance report
target    https://mcp.example.com/mcp
transport streamable-http
supported 2026-07-28, 2025-11-25

FAILED (2) — the server deviates from the spec here

  Result envelope
    ✗ cacheable list results carry the schema-required cache hints
        tools/list: ttlMs must be non-negative
    ✗ results identify the server in _meta
        expected io.modelcontextprotocol/serverInfo in result _meta, got undefined

NOT VERIFIED (4) — skipped; a skip is not a pass

  Capability methods
    – prompts/list returns schema-conformant prompts
    – prompts/get returns messages with a role and content
        target does not advertise the "prompts" capability: ["tools","resources"]

PASSED (29)
  ...

Summary
  29 passed  2 failed  4 not verified

Verdict: not conformant — 2 requirements violated.
```

Exit code is 0 when nothing failed. **Skips do not fail the run**, which is why
they are printed above the passes: a suite that skips most of itself can look
green while proving almost nothing, so every skip states the precondition that
was missing.

### MUST and SHOULD are reported separately

The spec uses both, and conflating them makes a tool untrustworthy in both
directions. *"Invalid cursors SHOULD result in an error with code -32602"* is a
recommendation; a server that ignores it is doing something worth knowing about,
but it is not non-conformant, and saying so alongside a violated MUST cheapens
every real finding.

So recommendations get their own section and stay out of the verdict and the exit
code:

```
RECOMMENDED, NOT MET (1) — the spec says SHOULD here, so this is not a conformance failure

  Capability methods
    ! an unrecognised cursor is answered rather than rejected
        the spec recommends -32602 for an invalid cursor; got a result instead: {"tools":[...

Summary
  20 passed  0 failed  23 not verified  1 recommended not met
```

That output is from a real run against `@modelcontextprotocol/server-everything`,
which returns page one for a cursor it never issued. Worth reporting; not a
failure.

## Supported revisions

The suite reasons about the **two most recent** revisions — currently
`2026-07-28` and `2025-11-25` — and the newest of those is the one whose
conformance it asserts.

That window is not a hardcoded list. It is read from the schemas vendored under
`spec/`, so the newest revision on disk is always the revision under test, and
adding support for a new spec is dropping its published `schema.json` at
`spec/<date>/schema.json` — no code change, and no way for a list and the shipped
schemas to disagree about what is supported.

A CI job checks that promise instead of trusting it: it asks the spec repository
what revisions exist and fails when one is published that is not vendored here.
"Always tests the latest spec" is the kind of claim that decays silently, so it
is verified on every push.

Both revisions in the window get a full conformance pass — point `--spec-version`
at either. Which cases run is decided by the schema, not by a date: `lib/schema.mjs`
derives a feature set from the vendored `$defs`, so a revision that has no
`server/discover` skips those cases *because it does not define the request*, and
gets its handshake checked instead.

```
2026-07-28: discover ✓  handshake ✗  perRequestVersion ✓  resultEnvelope ✓  listenSubscriptions ✓
2025-11-25: discover ✗  handshake ✓  perRequestVersion ✗  resultEnvelope ✗  resourceSubscribe ✓
```

That is why a skip reads *"2025-11-25 does not define resultEnvelope; nothing to
assert"* rather than naming a version the suite was told about. It also means a
future revision that moves features around selects the right cases with no code
change — the point of vendoring schemas rather than branching on dates.

Revisions outside the window are reported as **out of scope**, not judged. A
server advertising `2024-11-05` as its only older revision gets the
backward-compatibility cases skipped with that reason, rather than checked
against assumptions the suite cannot back with a schema. The handshake is checked
against the window too: a server that answers a stock client with an ancient
revision is reported, not passed over.

## Every case, one by one

43 cases. Which ones run against a given server is decided by three independent
gates, and each case below states its own:

1. *Revision* — derived from the vendored schema. `server/discover` cases cannot
   run against a revision whose schema has no `DiscoverRequest`.
2. *Capability* — read from what the server advertises. A server with no
   `prompts` capability skips the prompt cases instead of failing them.
3. *Transport* — a few requirements exist only on Streamable HTTP (status codes,
   response headers). They skip on stdio because they are absent there, not
   because they were met.

A case that runs nowhere is worth knowing about, which is why every skip prints
its reason and the summary counts them apart from the passes.

### server/discover — 2026-07-28 only

The revision made discover mandatory: a client must be able to pick a version
with no handshake and no session. A revision without it negotiates at
`initialize` instead, and these skip.

- **server/discover is answered without a session or handshake**  
  Calls discover with no version declared at all and checks the result carries
  every field the schema marks required. This is the case that fails first
  against a server built for an older revision, which is the correct outcome — it
  does not implement a MUST of the revision under test.
- **server/discover advertises the versions the server can serve**  
  `supportedVersions` must be a non-empty array of ISO dates, and the version the
  server negotiates for a client that declares none must itself appear in it.
  A server promising a default it cannot serve leaves version-less clients stuck.
- **server/discover is a CacheableResult with usable cache hints**  
  `ttlMs` must be a non-negative number and `cacheScope` must be `public` or
  `private`. Discover exists to be cached; hints a client cannot act on defeat it.
- **server/discover reports server identity and capabilities**  
  `capabilities` must be an object, and the server must name itself. `serverInfo`
  is not schema-required here, but a server that cannot say what it is makes every
  diagnostic downstream guesswork.
- **server/discover is stable across calls within its own TTL**  
  Calls discover twice and compares `supportedVersions`. A server that varies its
  answer has made its own `ttlMs` a lie, and a client that cached it is wrong.
- **server/discover advertises a revision this suite supports**  
  Checks the advertised list overlaps the two-revision window. Without an overlap
  this tool cannot make a conformance statement at all, and says so rather than
  asserting the current spec against a server built for an older one.

### The handshake — 2025-11-25 only

What discover replaced. Every revision before 2026-07-28 negotiates once, at
`initialize`, and expects `notifications/initialized` before ordinary traffic.

- **initialize returns the schema-required fields**  
  `InitializeResult` requires `capabilities`, `protocolVersion` and `serverInfo`.
  A client cannot proceed without all three, so they are checked against the
  schema's own list rather than a hand-copied one.
- **the handshake settles on the revision under test**  
  The suite asks for the revision it is testing and checks that is what it got.
  Carrying on after a silent downgrade would assert one revision's requirements
  against a server that agreed to a different one.
- **an unsupported version offered at the handshake is refused or downgraded, not echoed**  
  Offers `1999-01-01`. Refusing is conformant and answering with a real version is
  conformant; echoing back a version the server cannot speak is not, because the
  client will then go on to speak it.

### Version negotiation — 2026-07-28 only

The revision declares the protocol version on every request, in `_meta`, rather
than once per session.

- **a version declared in _meta is accepted**  
  The baseline: a correctly versioned request is answered. Runs against a real
  capability-backed method where the server has one, falling back to discover.
- **the negotiated version is echoed in the response header** *(Streamable HTTP only)*  
  The server must echo `MCP-Protocol-Version`, which is how a client confirms what
  it is actually talking to rather than what it asked for.
- **header and _meta version disagreement is a HeaderMismatch error** *(Streamable HTTP only)*  
  Sends deliberately disagreeing values and expects `-32020` with a 400. The spec
  requires the disagreement to be rejected rather than silently resolved in favour
  of one side, because either choice would be invisible to the client.
- **an unsupported version is rejected with the supported list**  
  Expects `-32022` carrying `data.supported`, and checks that list matches what
  discover advertises. A client that retries from the error and a client that
  reads discover must not be told different things.
- **an unsupported version is rejected with a 400 on Streamable HTTP** *(Streamable HTTP only)*  
  The status-code half of the requirement above, which only exists over HTTP.
- **clientInfo is optional (SHOULD, not MUST)**  
  Sends a request with `clientCapabilities` and `protocolVersion` but no
  `clientInfo`, which must still succeed. A server that requires it has turned a
  SHOULD into a MUST and will reject conformant clients.

### Version negotiation — both revisions

- **a request with no version at all is served on the default**  
  Backward compatibility from the client's side: a client that declares nothing
  must still be served, on whatever version the server defaults to. Checked on
  both revisions because both make the promise.

### Result envelope — 2026-07-28 only

`resultType` on every result, `ttlMs`/`cacheScope` on the cacheable ones, and
`serverInfo` moved into result `_meta` when the handshake went away.

- **every result carries the required resultType**  
  Checks each advertised cacheable list method returns `resultType: "complete"`.
  Methods the server does not advertise are skipped, not failed.
- **cacheable list results carry the schema-required cache hints**  
  Every field the schema marks required on each list result, plus `ttlMs`
  non-negative and `cacheScope` one of `public`/`private`. The assertion list
  comes from the schema, so tightening the schema tightens this case.
- **results identify the server in _meta**  
  `_meta` must carry `io.modelcontextprotocol/serverInfo` with a name and version.
  This is where a client learns what it is talking to now that there is no
  `initialize` result to read it from.
- **a client on an older version receives no newer-revision fields**  
  The compatibility guarantee in the other direction: a request made on an older
  revision must come back with no `resultType`, `ttlMs`, `cacheScope` or `_meta`.
  This is the case that catches a server implementing the envelope by simply
  adding the fields everywhere. It needs a second in-window revision the server
  also serves, and skips saying so if there is not one.
- **schema sanity: the envelope fields match the features selected**  
  Guards the vendored schema from being swapped underneath the suite, which would
  silently weaken every case above. Needs no server.

### subscriptions/listen — 2026-07-28 only

One long-lived POST-response stream replacing the HTTP GET stream and
`resources/subscribe`.

- **subscriptions/listen acknowledges only the opted-in notification types**  
  Opts into one type and checks the acknowledgment names it and nothing else. The
  acknowledgment is what a client relies on to know what it will receive, so a
  server adding types to it is promising traffic the client is not prepared for.
- **the acknowledgment carries the subscription id for correlation**  
  The ack's `_meta` must carry the listen request id. Without it a client running
  several subscriptions cannot tell which one was acknowledged.
- **a listen requesting no notification types is not a subscription to everything**  
  Asks for nothing. Rejecting that is conformant; answering it by subscribing to
  everything is not, since the client has no way to interpret what arrives.
- **a cancelled subscription ends with a conformant teardown result, if it sends one**  
  Opens a subscription, cancels it with `notifications/cancelled`, and checks the
  teardown result carries `resultType` and names the subscription it ended.
  Closing the stream quietly is also conformant, so that outcome skips — what this
  will not do is let a malformed teardown pass unnoticed.
- **schema sanity: SubscriptionsListenResult requires _meta and resultType**  
  The schema side of the same contract, which holds even against a server that
  never tears down. Needs no server.

### Capability methods — both revisions, gated on what the server advertises

These are the methods a server exists to serve. Each is gated on the capability
in question, so the same suite covers a tools-only server and a full one.

- **tools/list returns schema-conformant tools** *(needs `tools`)*  
  Every tool checked against the schema's required fields, names unique, and
  `inputSchema` an object of type `object`. A duplicate name makes a tool
  unaddressable, since `tools/call` selects by it.
- **tools/call on an unknown tool is an error, not a crash** *(needs `tools`)*  
  Either a JSON-RPC error or `isError: true` is conformant. Silently succeeding is
  not — a client would treat a call that never happened as done.
- **tools/call returns a schema-conformant CallToolResult** *(needs `tools`)*  
  Calls a tool and checks the result's required fields and content blocks. A tool
  declaring an `outputSchema` must return `structuredContent`, since that
  declaration is a promise clients build against. The suite will not invent
  arguments for a tool whose side effects it cannot know — pass `--tool-args` to
  opt in, otherwise it skips and says so.
- **prompts/list returns schema-conformant prompts** *(needs `prompts`)*  
  Schema-required fields on every prompt, and unique names for the same reason
  tools need them.
- **prompts/get returns messages with a role and content** *(needs `prompts`)*  
  Required fields on the result and on each message, with `role` one of
  `user`/`assistant`. Use `--prompt-args` for prompts with required arguments.
- **resources/list returns schema-conformant resources** *(needs `resources`)*  
  Required fields, plus every `uri` actually parsing as a URI — one that does not
  cannot be handed back to `resources/read`.
- **resources/templates/list returns schema-conformant templates** *(needs `resources`)*  
  Same treatment for templates. Skips if the server does not answer the method.
- **resources/read returns contents for every sampled resource** *(needs `resources`)*  
  Reads several listed resources rather than the first — a server that
  special-cases its first entry passes a one-resource check and fails a client on
  the second click. A listed resource that cannot be read is a failure, not a
  skip: the server put it in the list. Bounded by `--resource-sample` (default 5),
  and it says how many of how many it read.
- **resources/read on an unknown uri is an error** *(needs `resources`)*  
  The error path, so a client can distinguish a missing resource from an empty one.

### Pagination — both revisions

- **following nextCursor terminates and does not repeat a page** *(needs `tools`)*  
  Walks `nextCursor` to the end, failing if a tool appears twice or a cursor is
  reissued. The bug this catches is a cursor that yields the same page forever: a
  paginating client loops and a single-page check never sees it. Bounded by
  `--page-limit`.
- **an invalid pagination cursor is rejected (SHOULD)** *(needs `tools`)*  
  Sends a cursor the server never issued. The spec **recommends** `-32602` here
  rather than requiring it, so this is recorded under RECOMMENDED rather than
  failed — but silently returning page one is worth knowing, because a client
  cannot tell a rejected cursor from a reset one.

### Official SDK interop — both revisions

These cases drive the target with `@modelcontextprotocol/sdk` rather than this
suite's own client. That is the point of them: an independent implementation
checks a server's backward-compatibility claim against something that is not this
suite's assumptions. What the SDK does or does not support is read from the SDK
at runtime, never asserted here from memory.

- **the official SDK does not yet implement the newest revision**  
  The suite drives the newest revision over raw JSON-RPC because the official
  client cannot yet. Rather than assume that stays true, this reads the SDK's own
  supported-version list at runtime and **fails on purpose** once it covers the
  newest revision — the signal to migrate these cases onto the official client.
  Pinned to the newest revision, not the one under test, so `--spec-version` set
  to the older one does not trip it. Needs no server.
- **a stock official-SDK client completes the handshake**  
  A real third-party client connects and gets usable `serverInfo` and
  capabilities. Skips if the server serves nothing the SDK speaks.
- **the handshake settles on a revision inside the supported window**  
  A stock client will accept revisions considerably older than this suite reasons
  about. This checks what the server actually answers one with, so a fallback past
  the supported window is reported rather than passed over.
- **a stock official-SDK client can list tools** *(needs `tools`)*  
  `listTools()` throws if the payload fails the SDK's own schema validation, so a
  clean round-trip is independent evidence that no newer-revision field is leaking
  to a client that negotiated an older one.
- **a completely unconfigured SDK client works** *(Streamable HTTP only)*  
  A transport built with no `requestInit`, no custom headers and no
  server-specific configuration at all. If it passes, a stock MCP client can be
  pointed at the server and simply work. Skips when credentials are header-bound,
  since a client must then be configured for them.

### Suite integrity — both revisions

- **the suite is reading a schema that matches the features it selected**  
  Cross-checks the vendored schema against the feature set derived from it, so a
  schema swapped underneath the suite surfaces here rather than as a quietly
  weaker pass everywhere else. Needs no server.

### Assertions come from the schema, not from us

`lib/schema.mjs` reads the published `schema.json` for the revision under test —
vendored at `spec/<revision>/schema.json` — and exposes its own `required` lists
and method name constants. Tests assert against those rather than hand-copied field names,
so tightening the schema tightens the suite. Guard cases check that the schema
being read really is the revision claimed, so the assertions cannot be silently
weakened by pointing at an older one.

### It asks the server what to test

Nothing has to be configured to describe the target. The suite performs one
version-less `server/discover` and derives the rest from the answer — which is
exactly what that method exists for:

- a server that does not advertise the revision under test skips the
  revision-specific cases, quoting the list it *did* advertise
- capabilities absent from `discover` skip their methods rather than failing on
  something the server never claimed
- the backward-compatibility cases pick a real older revision out of
  `supportedVersions` — the newest one that is also inside the supported window —
  instead of trusting a configured constant

## Usage

Both transports the spec defines are supported. Pass one target, not both — they
select different transports.

```bash
# Streamable HTTP
npx @hasmcp/mcp-spec-test@latest -u https://mcp.example.com/mcp -t <token>

# stdio
npx @hasmcp/mcp-spec-test@latest -c "node ./build/index.js"
npx @hasmcp/mcp-spec-test@latest -c "uvx mcp-server-git --repository ."
```

Every flag has an environment-variable twin and **flags win**, so a one-off check
reads naturally on the command line while CI can keep a token out of the process
list:

```bash
MCP_URL=https://mcp.example.com/mcp MCP_TOKEN="$TOKEN" npx @hasmcp/mcp-spec-test@latest
```

| flag | env | meaning |
| --- | --- | --- |
| `-u`, `--url` | `MCP_URL` | Streamable HTTP endpoint |
| `-c`, `--command` | `MCP_COMMAND` | command to spawn and speak stdio to |
| `-t`, `--token` | `MCP_TOKEN` | bearer token |
| `--auth-mode` | `MCP_AUTH_MODE` | `header` (default), `query`, `none` |
| `--auth-header` | `MCP_AUTH_HEADER` | header carrying the token (default `authorization`) |
| `--auth-scheme` | `MCP_AUTH_SCHEME` | token prefix (default `Bearer`; empty for a bare token) |
| `--auth-query-param` | `MCP_AUTH_QUERY_PARAM` | query parameter in query mode (default `token`) |
| `-H`, `--header` | `MCP_EXTRA_HEADERS` | extra headers, `"x-tenant: acme, x-api-key: abc"` |
| `--spec-version` | `MCP_SPEC_VERSION` | revision to test; must be inside the supported window (default: the newest vendored) |
| `--spec-path` | `MCP_SPEC_PATH` | a `schema.json` to assert against instead of the vendored copy |
| `--default-version` | `MCP_SERVER_DEFAULT_VERSION` | the version the server negotiates for a client declaring none; probed if omitted |
| `--stream-budget-ms` | `MCP_STREAM_BUDGET_MS` | how long streaming cases wait (default 4000) |
| `--tool-args` | `MCP_TOOL_ARGS` | arguments per tool, `'{"search":{"query":"x"}}'` — see below |
| `--prompt-args` | `MCP_PROMPT_ARGS` | arguments per prompt, same shape |
| `--resource-sample` | `MCP_RESOURCE_SAMPLE` | how many listed resources to read (default 5) |
| `--page-limit` | `MCP_PAGE_LIMIT` | pages to follow before calling pagination broken (default 10) |
| `--verbose` | `MCP_VERBOSE` | also print the target's own stderr |
| `--only <pattern>` | — | run only test files matching a substring |
| `--tap` | — | raw TAP instead of the report, for CI parsing |

### Non-standard credentials

The spec expects an OAuth 2.1 bearer token in the standard `Authorization`
header, which is the default. Servers that deviate can still be tested:

```bash
# a custom header
npx @hasmcp/mcp-spec-test@latest -u "$URL" -t "$TOKEN" --auth-header x-api-key

# a bare token with no scheme
npx @hasmcp/mcp-spec-test@latest -u "$URL" -t "$TOKEN" --auth-header x-api-key --auth-scheme ''

# a query parameter
npx @hasmcp/mcp-spec-test@latest -u "$URL" -t "$TOKEN" --auth-mode query
```

Query mode is worth understanding rather than reaching for: a token in a URL
lands in access logs, proxy logs, browser history and `Referer` headers. What it
buys is interop. A credential in a *non-standard header* obliges every integrator
to plumb that header through their client before anything works; a query parameter
lets a stock client connect untouched. The suite has a case for exactly that
(`a completely unconfigured SDK client works`), which skips with the reason when
credentials are header-bound — so rather than take the claim on trust, point the
suite at your endpoint and see whether that case runs.

### Calls the suite will not guess at

A tool with required arguments is not called. The suite has no way to know that
`delete_everything` wants `{"confirm": true}` and `search` wants `{"query": "x"}`,
and inventing values for the first to exercise the second is not a trade a test
tool gets to make on your behalf. So those cases skip and say so.

You know your own server, so you can opt in:

```bash
npx @hasmcp/mcp-spec-test@latest -u "$URL" \
  --tool-args '{"search":{"query":"conformance"},"echo":{"message":"hi"}}' \
  --prompt-args '{"review":{"file":"README.md"}}'
```

Named tools are *preferred* over argument-free ones, since calling them exercises
argument handling as well. Anything not named keeps the old behaviour.

### In CI

```yaml
- run: npx @hasmcp/mcp-spec-test@1 --tap
  env:
    MCP_URL: ${{ vars.MCP_URL }}
    MCP_TOKEN: ${{ secrets.MCP_TOKEN }}
```

`--tap` emits raw TAP for a parser; without it you get the human report, which is
usually what you want in a log anyway.

Note the `@1` rather than `@latest`. Every other example here uses `@latest`,
which is right for a command someone types — they should get the current suite.
In a pipeline it means a release of this package can change a build nobody
touched, and a *conformance* suite is the worst place for that: a new case would
read as the server having regressed. Pinning the major keeps bug fixes flowing
while a new requirement lands only when you bump it.

## What a skip means

A skip is not a pass. `subscriptions/listen` needs a transport that really
streams, so those cases skip against an endpoint that answers the POST with a
plain JSON body. Capability cases skip when the capability is not advertised.
HTTP-specific cases skip on stdio, because those requirements do not exist there
— not because they were satisfied.

Read the reasons before claiming conformance. The suite prints every one.

## Testing a HasMCP server

HasMCP is one target among any others. Its MCP endpoint ignores `Authorization`,
so the credential goes in the URL:

```bash
npx @hasmcp/mcp-spec-test@latest \
  -u "https://app.hasmcp.com/mcp/<serverId>?token=<server access token>"
```

Quote the URL — an unquoted `?` and `&` are shell metacharacters. No `-t` is
needed: the token is already in the URL, so the suite sends no credential of its
own.

The endpoint also accepts the token in an `x-hasmcp-key` header
(`-t <token> --auth-header x-hasmcp-key`), and the middleware reads that header
first, falling back to the query parameter. The query form is the one worth
documenting because it needs no client-side plumbing at all, so a stock MCP client
can be pointed at a HasMCP endpoint and simply work. It is a real trade rather
than a free win: a bearer token in a URL lands in access logs, proxy logs, browser
history and `Referer` headers, so prefer the header where you control the client.

Two other things that will bite:

- The default rate limit (`HASMCP_APP_MCP_RATELIMIT_MAX_PER_IP`, 60 per 60s) is
  lower than a full pass, and surfaces as an opaque transport error rather than
  anything mentioning rate limits. Raise it on the instance under test.
- The **management API** uses `Authorization` while the **MCP endpoint** does
  not. Two different schemes on the same deployment.

## Development

```bash
npm install
npm test -- -u http://localhost:8080/mcp/<serverId> -t <token>
node --test "tests/**/*.test.mjs"     # raw node:test output, no report
```

The suite is plain `node:test`; `bin/mcp-spec-test.mjs` only turns arguments into
the environment the tests read and runs them under the reporter in
`lib/reporter.mjs`. Node 20 or newer.

| file | role |
| --- | --- |
| `lib/env.mjs` | target and credential resolution |
| `lib/transport.mjs` | Streamable HTTP and stdio behind one interface |
| `lib/rpc.mjs` | a hand-written client for the revision under test |
| `lib/schema.mjs` | assertions derived from the published schema |
| `lib/probe.mjs` | capability discovery, and the guards tests skip on |
| `lib/session.mjs` | the `initialize` handshake, for revisions that have one |
| `lib/level.mjs` | the MUST/SHOULD distinction |
| `lib/reporter.mjs` | the conformance report |
| `spec/<revision>/schema.json` | the vendored published schemas; the newest is the revision under test |

### Adding a revision

Drop the published `schema.json` at `spec/<date>/schema.json`. That is the whole
change: the window is derived from the directory, so a newer date becomes the
revision under test automatically and the oldest falls out of the window. Keeping
older schemas on disk is harmless — only the newest `REVISION_WINDOW` (2) are
supported, and `lib/env.mjs` is where that number lives if it ever needs to
change. Cases that
assert schema-required fields follow the new schema without being edited; cases
that name a method use the schema's own `const`, so a renamed method surfaces as
a missing definition rather than a silent pass.

Both revisions in the window get a full pass, including the handshake-based one —
which cases run follows from the schema's feature set rather than from the date.
A revision whose schema is not vendored is refused outright rather than
half-tested:

```
$ MCP_SPEC_VERSION=2024-11-05 npx @hasmcp/mcp-spec-test@latest -u "$URL"
MCP_SPEC_VERSION=2024-11-05 is not supported: it is not vendored.
Supported: 2026-07-28, 2025-11-25.
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
