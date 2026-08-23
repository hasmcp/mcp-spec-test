// The handshake must be sent outside any session.
//
// This pins a bug that produced two wrong verdicts from one cause. rpc.call
// opened a session before every request and attached its id to every request —
// including `initialize`, which *is* the handshake. A conformant server refuses a
// second initialize that reuses a session id (the official SDK asserts that
// refusal in its own tests), so:
//
//   - the SDK-interop case reported "target does not answer initialize:
//     duplicate \"initialize\" received", blaming the server for the suite's own
//     malformed request; and
//   - the negotiation case that offers an impossible version and treats any error
//     as proof of refusal *passed on the duplicate error*, certifying a
//     requirement it had never tested. A server echoing back "1999-01-01" was
//     called fully conformant.
//
// So the assertion here is about the wire: what headers does the handshake go out
// with, once a session already exists. Driven through the real transport against
// a real socket, because the whole failure lived in a header the suite added
// without meaning to.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// recordingServer stands in for a server that negotiates once per session and
// refuses a duplicate handshake, which is what the spec's lifecycle implies and
// what real servers do.
async function recordingServer() {
  const seen = []
  const sessions = new Set()
  let issued = 0

  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = body ? JSON.parse(body) : {}
    const sessionId = req.headers['mcp-session-id'] ?? null
    seen.push({ method: msg.method, sessionId })

    const send = (payload, headers = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...payload }))
    }

    if (msg.method === 'initialize') {
      if (sessionId && sessions.has(sessionId)) {
        return send({ error: { code: 0, message: 'duplicate "initialize" received' } })
      }
      const id = `sess-${++issued}`
      sessions.add(id)
      return send({
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'recording', version: '1' },
        },
      }, { 'mcp-session-id': id })
    }
    if (msg.method?.startsWith('notifications/')) return res.writeHead(202).end()
    return send({ result: { tools: [] } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// lib/env.mjs reads process.env once, at import time, so the target has to be in
// place before rpc.mjs is loaded. node:test gives each file its own process, so
// setting it here affects nothing else.
async function loadRpc(url) {
  process.env.MCP_URL = url
  process.env.MCP_SPEC_VERSION = '2025-11-25' // the revision that has a handshake
  delete process.env.MCP_COMMAND
  return import('../../lib/rpc.mjs')
}

test('the handshake is sent outside any session, even once one is open', async () => {
  const server = await recordingServer()
  try {
    const { call, rpcError } = await loadRpc(server.url)

    // Ordinary traffic first, which opens the session and gives the suite an id
    // it could wrongly attach later.
    await call('tools/list')

    const opened = server.seen.filter((r) => r.method === 'initialize')
    assert.equal(opened.length, 1, 'opening a session should take exactly one initialize')
    assert.equal(opened[0].sessionId, null, 'the first handshake cannot carry a session id')

    const listed = server.seen.find((r) => r.method === 'tools/list')
    assert.ok(listed.sessionId, 'ordinary requests must stay inside the session')

    // Now the handshake again. This is the case that was broken.
    const res = await call('initialize', {
      version: null,
      meta: false,
      headerVersion: null,
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mcp-spec-test', version: '1.0.0' },
      },
    })

    const handshakes = server.seen.filter((r) => r.method === 'initialize')
    assert.equal(handshakes.length, 2, 'the second handshake should have reached the server')
    assert.equal(
      handshakes[1].sessionId,
      null,
      'initialize must not carry the id of a session it is not part of — that is what a '
      + 'conformant server refuses as a duplicate handshake',
    )

    // And therefore the server answers it, rather than refusing it.
    assert.equal(rpcError(res), undefined, `expected a result, got ${JSON.stringify(rpcError(res))}`)
    assert.equal(res.body?.result?.protocolVersion, '2025-11-25')

    // The old behaviour is still reachable behind an explicit flag, so the
    // refusal itself can be exercised — and so that restoring it as the *default*
    // trips this file rather than a user's report. This is the request the suite
    // used to send without meaning to.
    const duplicate = await call('initialize', {
      version: null,
      meta: false,
      headerVersion: null,
      withinSession: true,
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mcp-spec-test', version: '1.0.0' },
      },
    })
    assert.equal(rpcError(duplicate)?.message, 'duplicate "initialize" received')
  } finally {
    await server.close()
  }
})
