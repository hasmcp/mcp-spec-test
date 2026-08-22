// subscriptions/listen.
//
// 2026-07-28 replaces the HTTP GET stream and resources/subscribe with one
// long-lived POST-response stream that carries only the notification types the
// client opted into, each tagged with a subscription id.
//
// This needs a target that actually streams. Where one does not, these cases
// skip with the reason rather than failing — a server that answers the POST with
// a plain JSON body has told us nothing about its conformance to the streaming
// requirements, and reporting that as a failure would be misleading either way.

import test from 'node:test'
import assert from 'node:assert/strict'

import { requireTarget } from '../lib/env.mjs'
import { requireLatest } from '../lib/probe.mjs'
import { listen, notify } from '../lib/rpc.mjs'
import {
  FEATURES,
  META_KEYS,
  methodConst,
  missingRequired,
  requireFeature,
  requiredFields,
} from '../lib/schema.mjs'

// A revision without subscriptions/listen has no such request to name, so the
// lookup is guarded rather than performed at import time.
const LISTEN = FEATURES.listenSubscriptions ? methodConst('SubscriptionsListenRequest') : 'subscriptions/listen'
const ACK = FEATURES.listenSubscriptions
  ? methodConst('SubscriptionsAcknowledgedNotification')
  : 'notifications/subscriptions/acknowledged'

test('subscriptions/listen acknowledges only the opted-in notification types', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'listenSubscriptions')) return
  if (!(await requireLatest(t))) return

  const { streaming, reason, frames } = await listen(LISTEN, {
    params: { notifications: { toolsListChanged: true } },
    id: 'listen-1',
    stop: (f) => f.some((x) => x.method === ACK),
  })
  if (!streaming) return t.skip(`target does not stream ${LISTEN} (${reason})`)

  const ack = frames.find((f) => f.method === ACK)
  if (!ack) return t.skip(`target streamed but sent no ${ACK}: ${JSON.stringify(frames).slice(0, 400)}`)

  // The spec requires the server not to acknowledge types the client did not ask
  // for, since the acknowledgment is what the client relies on to know what it
  // will receive.
  const agreed = ack.params?.notifications ?? {}
  assert.equal(agreed.toolsListChanged, true, 'the opted-in type must be acknowledged')
  assert.equal(agreed.promptsListChanged, undefined, 'a type not requested must not be acknowledged')
  assert.equal(agreed.resourcesListChanged, undefined, 'a type not requested must not be acknowledged')
})

test('the acknowledgment carries the subscription id for correlation', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'listenSubscriptions')) return
  if (!(await requireLatest(t))) return

  const { streaming, reason, frames } = await listen(LISTEN, {
    params: { notifications: { toolsListChanged: true, resourcesListChanged: true } },
    id: 'listen-corr',
    stop: (f) => f.some((x) => x.method === ACK),
  })
  if (!streaming) return t.skip(`target does not stream ${LISTEN} (${reason})`)

  const ack = frames.find((f) => f.method === ACK)
  if (!ack) return t.skip(`target streamed but sent no ${ACK}`)

  assert.equal(
    ack.params?._meta?.[META_KEYS.subscriptionId],
    'listen-corr',
    `ack _meta must carry the listen request id as ${META_KEYS.subscriptionId}`,
  )
})

// A client cannot open a subscription it has no way to interpret, so a listen
// asking for nothing must not be treated as asking for everything.
test('a listen requesting no notification types is not a subscription to everything', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'listenSubscriptions')) return
  if (!(await requireLatest(t))) return

  const { streaming, reason, frames } = await listen(LISTEN, {
    params: { notifications: {} },
    id: 'listen-empty',
    stop: (f) => f.some((x) => x.method === ACK),
  })
  if (!streaming) return t.skip(`target does not stream ${LISTEN} (${reason})`)

  const ack = frames.find((f) => f.method === ACK)
  if (!ack) return // rejecting an empty listen outright is also conformant

  const agreed = ack.params?.notifications ?? {}
  for (const [type, on] of Object.entries(agreed)) {
    assert.notEqual(on, true, `nothing was requested, yet "${type}" was acknowledged`)
  }
})

// Teardown, exercised rather than only documented.
//
// The result that ends a subscription is described as something the server sends
// when it tears the subscription down — during shutdown, for instance — which
// reads as untestable from the client side. But `notifications/cancelled` carries
// the request id of the listen, so a client *can* ask for the teardown, and then
// the contract is checkable.
//
// Both outcomes are conformant: the server may answer with the result, or it may
// simply close the stream, since the spec says an abrupt transport close carries
// no response. So this asserts the shape of the result when one arrives and skips
// when the server closes quietly — what it will not do is let a malformed
// teardown pass unnoticed.
test('a cancelled subscription ends with a conformant teardown result, if it sends one', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'listenSubscriptions')) return
  if (!(await requireLatest(t))) return

  const LISTEN_ID = 'listen-teardown'
  let cancelled = false

  const { streaming, reason, frames } = await listen(LISTEN, {
    params: { notifications: { toolsListChanged: true } },
    id: LISTEN_ID,
    // Cancel as soon as the subscription is acknowledged: before the ack there is
    // nothing established to tear down.
    onFrame: (frame) => {
      if (cancelled || frame.method !== ACK) return
      cancelled = true
      notify('notifications/cancelled', {
        params: { requestId: LISTEN_ID, reason: 'mcp-spec-test teardown check' },
      }).catch(() => {})
    },
    stop: (f) => f.some((x) => x.id === LISTEN_ID && x.result),
  })
  if (!streaming) return t.skip(`target does not stream ${LISTEN} (${reason})`)
  if (!cancelled) return t.skip(`target streamed but sent no ${ACK}, so there was nothing to cancel`)

  const teardown = frames.find((f) => f.id === LISTEN_ID && f.result)
  if (!teardown) {
    return t.skip('server closed the stream without a teardown result, which the spec permits')
  }

  const out = teardown.result
  const missing = missingRequired('SubscriptionsListenResult', out)
  assert.deepEqual(missing, [], `SubscriptionsListenResult missing schema-required fields: ${missing.join(', ')}`)
  assert.equal(
    out._meta?.[META_KEYS.subscriptionId],
    LISTEN_ID,
    `the teardown must name the subscription it ended, got ${JSON.stringify(out._meta)}`,
  )
  assert.equal(out.resultType, 'complete', `expected resultType "complete", got ${out.resultType}`)
})

// The schema side of the same contract, kept because it holds even where a server
// never tears down: it guards the requirement the behavioural case above relies
// on from being weakened underneath it.
test('schema sanity: SubscriptionsListenResult requires _meta and resultType', (t) => {
  if (!requireFeature(t, 'listenSubscriptions')) return
  const required = requiredFields('SubscriptionsListenResult')
  assert.ok(required.includes('_meta'), 'SubscriptionsListenResult must require _meta')
  assert.ok(required.includes('resultType'), 'SubscriptionsListenResult must require resultType')
  assert.ok(
    requiredFields('SubscriptionsListenResultMetaObject').includes(META_KEYS.subscriptionId),
    'the teardown _meta must require the subscriptionId',
  )
})
