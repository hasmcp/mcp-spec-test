// server/discover must still be asked for with the per-request _meta
// 2026-07-28 requires — even though it needs no handshake or session.
//
// This pins hasmcp/mcp-spec-test#10. The discover cases sent
// `call(DISCOVER, { version: null, meta: false, headerVersion: null })`,
// meant to keep the probe free of any prior handshake/session, but
// `meta: false` also stripped the per-request `_meta` that 2026-07-28
// requires on *every* request — discover included. Per
// spec/2026-07-28/schema.json: RequestParams.required includes "_meta", and
// RequestMetaObject.required includes protocolVersion and
// clientCapabilities, with no carve-out for discover just because it is
// handshake-free.
//
// A server built against the stable official SDK dispatches a request with no
// _meta to its legacy-era handler, where server/discover is undefined, and
// answers -32601 — so the suite was certifying a spec-compliant server as
// "not conformant" on every discover case. Driven through the real binary
// against a real socket, so a regression in discover.test.mjs's own call
// arguments — not just in rpc.mjs — trips this file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bin = join(root, 'bin', 'mcp-spec-test.mjs')

// stableSdkV2Server stands in for a server built against the official SDK's
// stable v2 API, exactly as described in the issue: server/discover answers
// only when _meta carries protocolVersion and clientCapabilities: a bare
// request falls through to the legacy dispatch, where the method does not
// exist, and comes back -32601.
async function stableSdkV2Server() {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = body ? JSON.parse(body) : {}

    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...payload }))
    }

    if (msg.method !== 'server/discover') {
      return send({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
    }

    const meta = msg.params?._meta ?? {}
    const hasProtocolVersion = !!meta['io.modelcontextprotocol/protocolVersion']
    const hasClientCapabilities = !!meta['io.modelcontextprotocol/clientCapabilities']
    if (!hasProtocolVersion || !hasClientCapabilities) {
      return send({ error: { code: -32601, message: 'Method not found: server/discover' } })
    }
    return send({
      result: {
        resultType: 'DiscoverResult',
        supportedVersions: ['2026-07-28'],
        ttlMs: 60000,
        cacheScope: 'public',
        capabilities: {},
        serverInfo: { name: 'stable-sdk-v2-fixture', version: '1.0.0' },
      },
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

test('server/discover is asked for with the current revision\'s required _meta, not stripped of it', async () => {
  const server = await stableSdkV2Server()
  try {
    const { code, stdout } = await run([
      '-u', server.url,
      '--spec-version', '2026-07-28',
      '--only', 'discover',
      '--tap',
    ])

    // A spec-compliant server must not be reported as failing every discover
    // case just because the probe forgot its own required envelope.
    assert.match(stdout, /^ok \d+ - server\/discover is answered without a session or handshake$/m, stdout)
    assert.doesNotMatch(stdout, /^not ok .* server\/discover/m, stdout)
    assert.equal(code, 0, `expected the suite to pass discover against a spec-compliant target, got exit ${code}:\n${stdout}`)
  } finally {
    await server.close()
  }
})
