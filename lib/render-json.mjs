// The report as JSON, for something that will read it rather than someone.
//
// The model is already the shape a consumer wants, so this is close to a
// serialisation. It is a published interface the moment anyone parses it, so the
// key names are camelCase like the rest of this tool's io, and `schema` is here to
// give a future change something to key off.

export const SCHEMA = 'hasmcp.mcp-spec-test.report/1'

export function renderJson(model) {
  return `${JSON.stringify({ schema: SCHEMA, ...model }, null, 2)}\n`
}
