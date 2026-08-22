// The capability-backed methods.
//
// Negotiation and the result envelope are the parts of 2026-07-28 that are new;
// these are the parts every server actually exists to serve. Each block is gated
// on the capability the target advertises in server/discover, so the same suite
// covers a tools-only server, a resources-only server and a full one without
// being told which it is looking at.
//
// Every assertion here comes from the vendored schema's own `required` lists, so
// what counts as conformant is the spec's answer, not this suite's opinion.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PAGE_LIMIT, PROMPT_ARGS, RESOURCE_SAMPLE, TOOL_ARGS, requireTarget } from '../lib/env.mjs'
import { requireCapability } from '../lib/probe.mjs'
import { should } from '../lib/level.mjs'
import { call, result, rpcError } from '../lib/rpc.mjs'
import { methodConst, missingRequired } from '../lib/schema.mjs'

// assertItems checks every element of a list result against the schema
// definition for that item type.
function assertItems(items, defName, label) {
  assert.ok(Array.isArray(items), `${label} must be an array, got ${typeof items}`)
  for (const [i, item] of items.entries()) {
    const missing = missingRequired(defName, item)
    assert.deepEqual(
      missing,
      [],
      `${label}[${i}] (${defName}) is missing schema-required fields: ${missing.join(', ')} — ${JSON.stringify(item).slice(0, 200)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// tools

test('tools/list returns schema-conformant tools', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'tools'))) return

  const out = result(await call(methodConst('ListToolsRequest'), {}), 'tools/list')
  assertItems(out.tools, 'Tool', 'tools')

  // A duplicate name makes a tool unaddressable, since tools/call selects by it.
  const names = out.tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, `tool names must be unique, got ${JSON.stringify(names)}`)

  // inputSchema must be a JSON Schema object, or a client cannot build a call.
  for (const tool of out.tools) {
    assert.equal(typeof tool.inputSchema, 'object', `${tool.name}: inputSchema must be an object`)
    assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema.type must be "object"`)
  }
})

test('tools/call on an unknown tool is an error, not a crash', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'tools'))) return

  const res = await call(methodConst('CallToolRequest'), {
    params: { name: '__mcp_spec_test_nonexistent_tool__', arguments: {} },
  })

  // Either a JSON-RPC error or a CallToolResult with isError: true is
  // conformant; silently succeeding is not.
  const err = rpcError(res)
  if (err) {
    assert.equal(typeof err.code, 'number', 'a JSON-RPC error needs a numeric code')
    return
  }
  const out = res.body?.result
  assert.ok(out, `expected either an error or a result, got ${JSON.stringify(res.body)}`)
  assert.equal(out.isError, true, `an unknown tool must be reported as an error, got ${JSON.stringify(out)}`)
})

// Calling a real tool needs either an argument-free one or arguments an operator
// supplied: the suite will not invent values for a tool whose side effects it
// cannot know.
test('tools/call returns a schema-conformant CallToolResult', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'tools'))) return

  const { tools } = result(await call(methodConst('ListToolsRequest'), {}), 'tools/list')

  // A tool named in --tool-args is one the operator has vouched for, so it is
  // preferred over an argument-free tool: it exercises argument handling too.
  if (tools.length === 0) return t.skip('target advertises the tools capability but lists no tools')

  const named = tools.find((tool) => TOOL_ARGS[tool.name])
  const safe = named ?? tools.find((tool) => (tool.inputSchema?.required ?? []).length === 0)
  if (!safe) {
    return t.skip(
      `every advertised tool requires arguments (${tools.map((x) => x.name).join(', ')}); `
      + 'pass --tool-args \'{"name":{...}}\' to opt in for tools whose side effects you know',
    )
  }
  const args = TOOL_ARGS[safe.name] ?? {}

  const res = await call(methodConst('CallToolRequest'), { params: { name: safe.name, arguments: args } })
  if (rpcError(res)) {
    return t.skip(`${safe.name} declined the call: ${JSON.stringify(rpcError(res))}`)
  }

  const out = result(res, 'tools/call')
  const missing = missingRequired('CallToolResult', out)
  assert.deepEqual(missing, [], `CallToolResult missing schema-required fields: ${missing.join(', ')}`)
  assert.ok(Array.isArray(out.content), 'content must be an array')
  for (const block of out.content) {
    assert.ok(block?.type, `every content block needs a type, got ${JSON.stringify(block)}`)
  }
  // outputSchema is a promise about structuredContent; a tool that declares one
  // and returns nothing structured has broken it.
  if (safe.outputSchema && out.isError !== true) {
    assert.ok(
      out.structuredContent !== undefined,
      `${safe.name} declares an outputSchema, so it must return structuredContent`,
    )
  }
})

// ---------------------------------------------------------------------------
// prompts

test('prompts/list returns schema-conformant prompts', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'prompts'))) return

  const out = result(await call(methodConst('ListPromptsRequest'), {}), 'prompts/list')
  assertItems(out.prompts, 'Prompt', 'prompts')

  const names = out.prompts.map((p) => p.name)
  assert.equal(new Set(names).size, names.length, `prompt names must be unique, got ${JSON.stringify(names)}`)
})

test('prompts/get returns messages with a role and content', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'prompts'))) return

  const { prompts } = result(await call(methodConst('ListPromptsRequest'), {}), 'prompts/list')
  if (prompts.length === 0) return t.skip('target advertises the prompts capability but lists no prompts')

  const named = prompts.find((p) => PROMPT_ARGS[p.name])
  const safe = named ?? prompts.find((p) => !(p.arguments ?? []).some((a) => a.required))
  if (!safe) {
    return t.skip(
      `every advertised prompt requires arguments (${prompts.map((x) => x.name).join(', ')}); `
      + 'pass --prompt-args \'{"name":{...}}\' to supply them',
    )
  }

  const res = await call(methodConst('GetPromptRequest'), {
    params: { name: safe.name, ...(PROMPT_ARGS[safe.name] ? { arguments: PROMPT_ARGS[safe.name] } : {}) },
  })
  if (rpcError(res)) return t.skip(`${safe.name} declined: ${JSON.stringify(rpcError(res))}`)

  const out = result(res, 'prompts/get')
  const missing = missingRequired('GetPromptResult', out)
  assert.deepEqual(missing, [], `GetPromptResult missing schema-required fields: ${missing.join(', ')}`)
  assertItems(out.messages, 'PromptMessage', 'messages')
  for (const msg of out.messages) {
    assert.ok(['user', 'assistant'].includes(msg.role), `role must be user|assistant, got ${msg.role}`)
  }
})

// ---------------------------------------------------------------------------
// resources

test('resources/list returns schema-conformant resources', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'resources'))) return

  const out = result(await call(methodConst('ListResourcesRequest'), {}), 'resources/list')
  assertItems(out.resources, 'Resource', 'resources')

  for (const r of out.resources) {
    // A uri that will not parse cannot be passed back to resources/read.
    assert.doesNotThrow(() => new URL(r.uri), `resource uri "${r.uri}" is not a valid URI`)
  }
})

test('resources/templates/list returns schema-conformant templates', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'resources'))) return

  const res = await call(methodConst('ListResourceTemplatesRequest'), {})
  if (rpcError(res)) return t.skip(`target does not answer resources/templates/list: ${JSON.stringify(rpcError(res))}`)

  const out = result(res, 'resources/templates/list')
  assertItems(out.resourceTemplates, 'ResourceTemplate', 'resourceTemplates')
})

// Reads several listed resources, not just the first. A server that special-cases
// its first entry — or whose later URIs are stale — passes a one-resource check
// and fails a real client on the second click.
test('resources/read returns contents for every sampled resource', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'resources'))) return

  const { resources } = result(await call(methodConst('ListResourcesRequest'), {}), 'resources/list')
  if (resources.length === 0) return t.skip('target lists no resources to read')

  const sample = resources.slice(0, RESOURCE_SAMPLE)
  if (resources.length > sample.length) {
    // Said out loud rather than left implicit: a bounded check must not read as
    // "every resource was verified".
    t.diagnostic(`read ${sample.length} of ${resources.length} listed resources (MCP_RESOURCE_SAMPLE)`)
  }

  let read = 0
  for (const target of sample) {
    const res = await call(methodConst('ReadResourceRequest'), { params: { uri: target.uri } })
    if (rpcError(res)) {
      // A listed resource that cannot be read is a real inconsistency, not a
      // reason to skip: the server put it in the list.
      assert.fail(`${target.uri} is listed but declined the read: ${JSON.stringify(rpcError(res))}`)
    }

    const out = result(res, 'resources/read')
    const missing = missingRequired('ReadResourceResult', out)
    assert.deepEqual(
      missing,
      [],
      `${target.uri}: ReadResourceResult missing schema-required fields: ${missing.join(', ')}`,
    )
    assert.ok(Array.isArray(out.contents), `${target.uri}: contents must be an array`)

    for (const [i, c] of out.contents.entries()) {
      assert.ok(c?.uri, `${target.uri}: contents[${i}] must carry a uri`)
      // Each entry is either text or blob; neither is a valid ResourceContents.
      const isText = typeof c.text === 'string'
      const isBlob = typeof c.blob === 'string'
      assert.ok(
        isText || isBlob,
        `${target.uri}: contents[${i}] must carry either text or blob: ${JSON.stringify(c).slice(0, 200)}`,
      )
    }
    read++
  }
  assert.ok(read > 0, 'no resource was read')
})

test('resources/read on an unknown uri is an error', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'resources'))) return

  const res = await call(methodConst('ReadResourceRequest'), {
    params: { uri: 'mcp-spec-test://nonexistent/resource' },
  })
  assert.ok(
    rpcError(res) || res.body?.result?.isError,
    `reading an unknown uri must fail, got ${JSON.stringify(res.body).slice(0, 300)}`,
  )
})

// ---------------------------------------------------------------------------
// pagination

// Follows nextCursor to the end rather than only rejecting a bogus cursor. The
// failure this catches is a server that returns a cursor which yields the same
// page again: a paginating client then loops forever, and a single-page check
// never sees it.
test('following nextCursor terminates and does not repeat a page', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'tools'))) return

  const seenCursors = new Set()
  const seenNames = new Set()
  let cursor
  let pages = 0

  while (pages < PAGE_LIMIT) {
    const res = await call(methodConst('ListToolsRequest'), { params: cursor ? { cursor } : undefined })
    if (rpcError(res)) {
      assert.fail(`page ${pages + 1}: a cursor the server issued was refused: ${JSON.stringify(rpcError(res))}`)
    }
    const out = result(res, 'tools/list')
    pages++

    for (const tool of out.tools ?? []) {
      assert.ok(
        !seenNames.has(tool.name),
        `tool "${tool.name}" appeared on two pages — the cursor is not advancing`,
      )
      seenNames.add(tool.name)
    }

    if (!out.nextCursor) break

    assert.ok(
      !seenCursors.has(out.nextCursor),
      `nextCursor "${out.nextCursor}" was issued twice — following it would loop forever`,
    )
    seenCursors.add(out.nextCursor)
    cursor = out.nextCursor
  }

  assert.ok(
    pages < PAGE_LIMIT,
    `pagination did not terminate within ${PAGE_LIMIT} pages (MCP_PAGE_LIMIT)`,
  )
  if (pages === 1) t.diagnostic('target returned a single page; multi-page behaviour was not exercised')
})

// The spec says invalid cursors SHOULD return -32602, not MUST. Silently
// returning page one for a cursor the server never issued is a real hazard — a
// client cannot tell a rejected cursor from a reset one — but it is a
// recommendation, so it is recorded rather than failed. Reporting it as "not
// conformant" alongside violated MUSTs would overstate it and cheapen the rest.
test('an invalid pagination cursor is rejected (SHOULD)', async (t) => {
  if (!requireTarget(t)) return
  if (!(await requireCapability(t, 'tools'))) return

  const res = await call(methodConst('ListToolsRequest'), { params: { cursor: '__mcp_spec_test_bogus_cursor__' } })
  const err = rpcError(res)

  // The detail is built eagerly as an argument, so it must be safe to build even
  // when the recommendation held and there is no result to describe.
  const shown = JSON.stringify(res.body?.result ?? null).slice(0, 200)
  if (!should(
    t,
    !!err,
    'an unrecognised cursor is answered rather than rejected',
    `the spec recommends -32602 for an invalid cursor; got a result instead: ${shown}`,
  )) return

  should(
    t,
    err.code === -32602,
    'an invalid cursor is rejected with the wrong code',
    `the spec recommends -32602 (Invalid params); got ${err.code} (${err.message})`,
  )
})
