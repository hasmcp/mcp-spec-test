// Every case's permanent telemetry id.
//
// These numbers are the wire format the usage endpoint stores, so two rules hold
// and neither is enforceable by the language:
//
//   1. Never renumber. An id is a case's permanent identity, so a row recorded a
//      year ago still points at the same case.
//   2. Never reuse. A retired case keeps its id forever; handing it to a new case
//      would graft one case's history onto another.
//
// New cases append at the end. The keys are the case names verbatim, which means
// renaming a case would orphan its id — tests/unit/case-ids.test.mjs fails if a
// case has no id or an id names a case that no longer exists, so that cannot
// happen quietly.
//
// The comment beside each id is the slug the endpoint's own registry uses for the
// same number. The two must stay in step; the numbers are what actually matter.
export const CASE_IDS = new Map([
  // tests/negotiation.test.mjs
  ['a version declared in _meta is accepted', 1], // negotiation/meta-version-accepted
  ['the negotiated version is echoed in the response header', 2], // negotiation/version-echoed-in-header
  ['header and _meta version disagreement is a HeaderMismatch error', 3], // negotiation/header-meta-mismatch
  ['an unsupported version is rejected with the supported list', 4], // negotiation/unsupported-version-lists-supported
  ['an unsupported version is rejected with a 400 on Streamable HTTP', 5], // negotiation/unsupported-version-http-400
  ['a request with no version at all is served on the default', 6], // negotiation/missing-version-uses-default
  ['clientInfo is optional (SHOULD, not MUST)', 7], // negotiation/client-info-optional
  ['initialize returns the schema-required fields', 8], // negotiation/initialize-required-fields
  ['the handshake settles on the revision under test', 9], // negotiation/handshake-settles-on-revision
  ['an unsupported version offered at the handshake is refused or downgraded, not echoed', 10], // negotiation/unsupported-handshake-not-echoed

  // tests/discover.test.mjs
  ['server/discover is answered without a session or handshake', 11], // discover/no-session-required
  ['server/discover advertises the versions the server can serve', 12], // discover/advertises-versions
  ['server/discover is a CacheableResult with usable cache hints', 13], // discover/cacheable-with-hints
  ['server/discover reports server identity and capabilities', 14], // discover/reports-identity
  ['server/discover is stable across calls within its own TTL', 15], // discover/stable-within-ttl
  ['server/discover advertises a revision this suite supports', 16], // discover/advertises-supported-revision
  ['the suite is reading a schema that matches the features it selected', 17], // discover/schema-matches-features

  // tests/result-envelope.test.mjs
  ['every result carries the required resultType', 18], // envelope/result-type-present
  ['cacheable list results carry the schema-required cache hints', 19], // envelope/cacheable-list-hints
  ['results identify the server in _meta', 20], // envelope/identifies-server-in-meta
  ['a client on an older version receives no newer-revision fields', 21], // envelope/no-newer-revision-fields
  ['schema sanity: the envelope fields match the features selected', 22], // envelope/schema-sanity

  // tests/capabilities.test.mjs
  ['tools/list returns schema-conformant tools', 23], // capabilities/tools-list-conformant
  ['tools/call on an unknown tool is an error, not a crash', 24], // capabilities/tools-call-unknown-tool
  ['tools/call returns a schema-conformant CallToolResult', 25], // capabilities/tools-call-result-conformant
  ['prompts/list returns schema-conformant prompts', 26], // capabilities/prompts-list-conformant
  ['prompts/get returns messages with a role and content', 27], // capabilities/prompts-get-messages
  ['resources/list returns schema-conformant resources', 28], // capabilities/resources-list-conformant
  ['resources/templates/list returns schema-conformant templates', 29], // capabilities/resource-templates-list-conformant
  ['resources/read returns contents for every sampled resource', 30], // capabilities/resources-read-contents
  ['resources/read on an unknown uri is an error', 31], // capabilities/resources-read-unknown-uri
  ['following nextCursor terminates and does not repeat a page', 32], // capabilities/pagination-terminates
  ['an invalid pagination cursor is rejected (SHOULD)', 33], // capabilities/invalid-cursor-rejected

  // tests/subscriptions.test.mjs
  ['subscriptions/listen acknowledges only the opted-in notification types', 34], // subscriptions/acknowledges-opted-in-types
  ['the acknowledgment carries the subscription id for correlation', 35], // subscriptions/ack-carries-subscription-id
  ['a listen requesting no notification types is not a subscription to everything', 36], // subscriptions/empty-listen-not-catch-all
  ['a cancelled subscription ends with a conformant teardown result, if it sends one', 37], // subscriptions/cancel-teardown-conformant
  ['schema sanity: SubscriptionsListenResult requires _meta and resultType', 38], // subscriptions/schema-sanity

  // tests/sdk-compat.test.mjs
  ['the official SDK does not yet implement the newest revision', 39], // sdk/newest-revision-unimplemented
  ['a stock official-SDK client completes the handshake', 40], // sdk/client-completes-handshake
  ['the handshake settles on a revision inside the supported window', 41], // sdk/settles-inside-supported-window
  ['a stock official-SDK client can list tools', 42], // sdk/client-lists-tools
  ['a completely unconfigured SDK client works', 43], // sdk/unconfigured-client-works
])

/** The id for a case name, or undefined for a name with no id. */
export function caseId(name) {
  return CASE_IDS.get(name)
}
