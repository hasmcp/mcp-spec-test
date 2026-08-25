// server/discover must still be asked for with the per-request _meta AND the
// matching MCP-Protocol-Version header 2026-07-28 requires — even though it
// needs no handshake or session.
//
// This pins two bugs found back to back in the same six calls.
//
// hasmcp/mcp-spec-test#10: the discover cases sent
// `call(DISCOVER, { version: null, meta: false, headerVersion: null })`,
// meant to keep the probe free of any prior handshake/session, but
// `meta: false` also stripped the per-request `_meta` that 2026-07-28
// requires on *every* request — discover included. Per
// spec/2026-07-28/schema.json: RequestParams.required includes "_meta", and
// RequestMetaObject.required includes protocolVersion and
// clientCapabilities, with no carve-out for discover just because it is
// handshake-free. A server built against the stable official SDK dispatches
// a request with no _meta to its legacy-era handler, where server/discover is
// undefined, and answers -32601.
//
// Fixing that by simply dropping `meta: false` (and `version: null`) left
// `headerVersion: null` behind, which is the second bug: the Streamable HTTP
// transport spec requires "Every POST request to the MCP endpoint MUST
// include an MCP-Protocol-Version header", and that "the header value MUST
// match the io.modelcontextprotocol/protocolVersion field carried in the
// request body's _meta" — again with no exception for discover. Sending
// _meta.protocolVersion with no matching header is exactly the mismatch a
// conformant server MUST reject, so the suite's own probe was now the thing
// failing spec, on the transport where it matters (stdio has no header to
// omit, which is why the first fix looked complete under a stdio fixture).
//
// A third bug lived in the same six calls: 2026-07-28's "Standard Request
// Headers" table requires Mcp-Method — mirroring the JSON-RPC method name —
// on every request, with no carve-out for discover either. rpc.mjs's call()
// never sent it at all, for any method, on any request.
//
// Driven through the real binary against a real socket, so a regression in
// discover.test.mjs's own call arguments — not just in rpc.mjs — trips this
// file.

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
// exist, and comes back -32601. It also enforces the Streamable HTTP
// transport's own requirement that the MCP-Protocol-Version header agree
// with _meta.protocolVersion, as a spec-compliant HTTP server is entitled to.
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
    const protocolVersion = meta['io.modelcontextprotocol/protocolVersion']
    const hasClientCapabilities = !!meta['io.modelcontextprotocol/clientCapabilities']
    if (!protocolVersion || !hasClientCapabilities) {
      return send({ error: { code: -32601, message: 'Method not found: server/discover' } })
    }

    // The Streamable HTTP transport requires this header on every POST, and
    // that it matches _meta.protocolVersion — with no exception for discover.
    const headerVersion = req.headers['mcp-protocol-version']
    if (headerVersion !== protocolVersion) {
      return send({
        error: {
          code: -32020,
          message: `Mcp-Protocol-Version header (${headerVersion ?? 'missing'}) does not match `
            + `_meta protocolVersion (${protocolVersion})`,
        },
      })
    }

    // Required on every request, mirroring the JSON-RPC method name — no
    // exception for discover.
    if (req.headers['mcp-method'] !== msg.method) {
      return send({
        error: { code: -32020, message: `missing or mismatched Mcp-Method header for ${msg.method}` },
      })
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
