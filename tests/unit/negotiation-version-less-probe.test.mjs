// "a request with no version at all is served on the default" must not
// assert a 2026-07-28-only method works version-lessly against a dual-era
// server that never claimed 2026-07-28 support in the first place.
//
// A server owner reported this reproducibly: their server genuinely
// implements server/discover (answers a fully declared 2026-07-28 request
// correctly) but only lists ["2025-11-25", "2025-06-18", "2025-03-26",
// "2024-11-05"] in supportedVersions — it never claims 2026-07-28 itself.
// Per Streamable HTTP's Protocol Version Header section: "a server that
// supports clients implementing protocol versions earlier than 2025-06-18
// ... MAY treat a request that omits the header as protocol version
// 2025-03-26." That is a real, spec-permitted default, and under it
// server/discover is undefined — so a version-less discover call correctly
// comes back "method not found", which this suite was reporting as a
// conformance *failure* against the 2026-07-28 the server never claimed.
//
// The fix: this case only trusts discover — or runs at all — once the
// target's own advertised versions include the revision under test
// (`requireLatest`, the same gate every sibling case in negotiation.test.mjs
// already uses). A fallback method choice does not actually solve this: the
// server's version-less default could be any older, handshake-based
// revision this suite is not performing the handshake for, and that server
// legitimately refusing a stateless call as "needs a session first" is
// correct behaviour under its own chosen default, not a failure of this
// requirement either.
//
// Driven through the real binary against a real socket, so a regression in
// how the method is chosen — not just in probe() itself — trips this file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bin = join(root, 'bin', 'mcp-spec-test.mjs')

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

// dualEraOlderDefaultServer models the reported server: it fully answers a
// modern, fully-declared server/discover request, but the DiscoverResult it
// returns says its own supportedVersions top out at 2025-11-25 — it never
// claims 2026-07-28 for itself. A version-less request (no header, no
// _meta) is treated as the oldest revision it lists, where server/discover
// and tools/list are both undefined.
async function dualEraOlderDefaultServer() {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = body ? JSON.parse(body) : {}

    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...payload }))
    }

    const meta = msg.params?._meta ?? {}
    const declaredVersion = meta['io.modelcontextprotocol/protocolVersion']
    const headerVersion = req.headers['mcp-protocol-version']

    if (msg.method === 'server/discover' && declaredVersion && headerVersion === declaredVersion) {
      return send({
        result: {
          resultType: 'DiscoverResult',
          supportedVersions: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          ttlMs: 60000,
          cacheScope: 'public',
          capabilities: { tools: {} },
          serverInfo: { name: 'older-default-fixture', version: '1.0.0' },
        },
      })
    }

    // Anything under-declared — including this exact request repeated
    // without a version — falls to the server's own oldest default, where
    // neither of these methods exists.
    return send({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('a dual-era server that never claims 2026-07-28 is skipped, not failed, for the version-less case', async () => {
  const server = await dualEraOlderDefaultServer()
  try {
    const { code, stdout } = await run([
      '-u', server.url,
      '--spec-version', '2026-07-28',
      '--only', 'negotiation',
      '--tap',
    ])
    assert.match(
      stdout,
      /^ok \d+ - a request with no version at all is served on the default # SKIP/m,
      stdout,
    )
    assert.doesNotMatch(stdout, /^not ok .* a request with no version at all/m, stdout)
    assert.equal(code, 0, `expected the case to skip cleanly, not fail, got exit ${code}:\n${stdout}`)
  } finally {
    await server.close()
  }
})
