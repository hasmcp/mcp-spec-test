// Interoperability against the official client library.
//
// As of @modelcontextprotocol/sdk 1.30.0 the SDK's LATEST_PROTOCOL_VERSION is
// still 2025-11-25, and its bundle contains no reference to 2026-07-28,
// server/discover, subscriptions/listen or resultType. It therefore cannot drive
// the current revision — the raw-JSON-RPC suites cover that.
//
// What it can do is worth more than it sounds: it is an *independent*
// implementation of the handshake-based revisions, so it checks a server's
// backward-compatibility claim with something other than this suite's own
// assumptions. A server that serves 2026-07-28 must still satisfy a stock SDK
// client that insists on initialize.

import test from 'node:test'
import assert from 'node:assert/strict'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'

import {
  MCP_AUTH_MODE,
  MCP_AUTH_QUERY_PARAM,
  MCP_COMMAND,
  MCP_TOKEN,
  SUPPORTED_REVISIONS,
  TRANSPORT,
  VERBOSE,
  inWindow,
  authHeaders,
  extraHeaders,
  requireTarget,
  LATEST_SPEC_VERSION,
  targetURL,
} from '../lib/env.mjs'
import { probe } from '../lib/probe.mjs'
import { call, rpcError } from '../lib/rpc.mjs'
import { tokenize } from '../lib/transport.mjs'

// connect builds the SDK's own transport for whichever target is configured. In
// header mode a non-standard auth header has to be threaded through requestInit,
// because the SDK sends `Authorization` and offers no way to rename it.
async function connect(name = 'mcp-spec-test') {
  let transport
  if (TRANSPORT === 'stdio') {
    const argv = tokenize(MCP_COMMAND)
    // 'ignore' unless asked: the SDK inherits the child's stderr by default, and
    // a server that greets on startup would print a banner over the report once
    // per test file.
    transport = new StdioClientTransport({
      command: argv[0],
      args: argv.slice(1),
      stderr: VERBOSE ? 'inherit' : 'ignore',
    })
  } else {
    transport = new StreamableHTTPClientTransport(new URL(targetURL()), {
      requestInit: { headers: { ...authHeaders(), ...extraHeaders() } },
    })
  }
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

// Documents the gap rather than assuming it. When a future SDK adds the newest
// revision this fails on purpose — the signal to migrate cases onto the official
// client instead of discovering the support months later.
//
// Pinned to the newest revision the suite knows about, not to whichever one is
// under test: the SDK already drives the older revision in the window, so keying
// this off LATEST_SPEC_VERSION would fail simply because someone ran the suite
// with --spec-version pointed at the older one, which says nothing about the SDK.
test('the official SDK does not yet implement the newest revision', () => {
  const newest = SUPPORTED_REVISIONS[0]
  assert.ok(
    !SUPPORTED_PROTOCOL_VERSIONS.includes(newest),
    `the SDK now supports ${newest} (LATEST=${LATEST_PROTOCOL_VERSION}) — `
      + 'the raw-JSON-RPC suites can start migrating to the official client',
  )
})

test('a stock official-SDK client completes the handshake', async (t) => {
  if (!requireTarget(t)) return

  const p = await probe()
  if (p.ok && !p.olderVersion && !p.supportedVersions.some((v) => SUPPORTED_PROTOCOL_VERSIONS.includes(v))) {
    return t.skip(`target serves only ${JSON.stringify(p.supportedVersions)}, none of which this SDK speaks`)
  }

  const client = await connect()
  try {
    const info = client.getServerVersion()
    assert.ok(info?.name, `expected serverInfo from initialize, got ${JSON.stringify(info)}`)
    assert.ok(client.getServerCapabilities(), 'expected negotiated server capabilities')
  } finally {
    await client.close()
  }
})

// The handshake is where an older client and the server agree on a revision, so
// it is where a server can quietly fall back further than the suite's window. The
// SDK offers 2025-11-25 down to 2024-10-07; a server that answers with one of the
// ancient ones is outside what this tool reasons about, and that is worth
// reporting rather than passing over.
//
// Driven over raw JSON-RPC rather than through the SDK, because the SDK keeps the
// negotiated version private — it hands it to the transport and exposes no
// accessor. The offer is still the SDK's own LATEST_PROTOCOL_VERSION, so this is
// what a stock client would actually ask for.
test('the handshake settles on a revision inside the supported window', async (t) => {
  if (!requireTarget(t)) return

  const res = await call('initialize', {
    version: null,
    meta: false,
    headerVersion: null,
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-spec-test', version: '1.0.0' },
    },
  })
  if (rpcError(res)) return t.skip(`target does not answer initialize: ${JSON.stringify(rpcError(res))}`)

  const negotiated = res.body?.result?.protocolVersion
  assert.ok(negotiated, `initialize must return a protocolVersion, got ${JSON.stringify(res.body?.result)}`)
  assert.ok(
    inWindow(negotiated),
    `a client offering ${LATEST_PROTOCOL_VERSION} was answered with ${negotiated}, `
      + `outside the supported window (${SUPPORTED_REVISIONS.join(', ')})`,
  )
})

test('a stock official-SDK client can list tools', async (t) => {
  if (!requireTarget(t)) return
  const p = await probe()
  if (p.ok && !p.capabilities?.tools) return t.skip('target advertises no tools capability')

  const client = await connect()
  try {
    // listTools() throws if the payload fails the SDK's own zod validation, so a
    // successful round-trip is itself evidence that no field from the newer
    // revision is leaking to a client that negotiated an older one.
    const { tools } = await client.listTools()
    assert.ok(Array.isArray(tools), 'tools/list must return an array')
    for (const tool of tools) {
      assert.ok(tool.name, 'every tool needs a name')
      assert.ok(tool.inputSchema, `tool ${tool.name} must expose an inputSchema`)
    }
  } finally {
    await client.close()
  }
})

// The strongest interop statement available on HTTP: a transport built with no
// requestInit, no custom headers and no server-specific configuration at all. It
// only applies where credentials are not required in a header — an unauthenticated
// endpoint, or one that accepts the token as a query parameter.
test('a completely unconfigured SDK client works', async (t) => {
  if (!requireTarget(t)) return
  if (TRANSPORT !== 'http') return t.skip('a stdio target needs no header plumbing; nothing to prove')
  if (MCP_TOKEN && MCP_AUTH_MODE === 'header') {
    return t.skip(`credentials go in the ${Object.keys(authHeaders())[0]} header, so a client must be configured for it`)
  }

  const url = new URL(targetURL())
  if (MCP_TOKEN && MCP_AUTH_MODE === 'query') url.searchParams.set(MCP_AUTH_QUERY_PARAM, MCP_TOKEN)

  const client = new Client({ name: 'unmodified-mcp-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(url))
  try {
    assert.ok(client.getServerVersion()?.name, 'expected serverInfo from initialize')
  } finally {
    await client.close()
  }
})
