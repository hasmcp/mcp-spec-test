// A conformance report, not a test log.
//
// The default node:test output answers "did the suite pass". The question a
// person actually has is "what does this server do, and where does it deviate",
// and the two differ most in the skips: a skipped case is not a pass, and a run
// full of them can look green while proving almost nothing. So the report has
// three sections — failed, passed, and not verified, each with the reason the
// suite gave — and a verdict that counts them honestly.
//
// This file now only gathers: it turns node:test events into the model in
// report-model.mjs, and hands that to whichever renderer --output selected. What
// the report says lives there; what it looks like lives in the render-* modules.

import { dim } from './colour.mjs'
import { notApplicable, parseShould } from './level.mjs'
import { emit } from './output.mjs'
import { buildModel } from './report-model.mjs'
import { report as reportUsage } from './telemetry.mjs'

export default async function* report(source) {
  const failed = []
  const passed = []
  const skipped = []
  const inapplicable = []
  const recommended = []
  let summary = null

  for await (const event of source) {
    const data = event.data
    switch (event.type) {
      case 'test:pass': {
        if (data.todo) {
          skipped.push({ ...data, reason: `TODO: ${data.todo}` })
          break
        }
        if (!data.skip) {
          passed.push(data)
          break
        }
        const reason = typeof data.skip === 'string' ? data.skip : 'no reason given'
        // A case the revision or transport does not define is not a gap in the
        // run; separating the two is the difference between a list worth reading
        // and a list worth ignoring.
        const na = notApplicable(reason)
        if (na) inapplicable.push({ ...data, reason: na })
        else skipped.push({ ...data, reason })
        break
      }
      case 'test:fail':
        // A file-level failure is a rollup of the cases below it, already listed.
        if (data.details?.error?.failureType !== 'subtestsFailed') failed.push(data)
        break
      case 'test:diagnostic': {
        // A SHOULD that was not met: recorded, not asserted, so it never touches
        // the verdict or the exit code.
        const rec = parseShould(data)
        if (rec) recommended.push({ ...rec, file: data.file })
        break
      }
      case 'test:stderr':
        // Server logs on stderr are useful when something fails; keep them, but
        // out of the report body.
        yield dim(data.message)
        break
      case 'test:summary':
        if (!data.file) summary = data
        break
      default:
        break
    }
  }

  const model = buildModel({ failed, passed, skipped, inapplicable, recommended, summary })

  yield emit(model).stdout

  // Last thing, deliberately. The report is already written, so this can neither
  // delay what the user reads nor change it. `report` swallows every failure and
  // honours the opt-out, so there is nothing to handle here.
  //
  // `inapplicable` is excluded on purpose: those cases are not results that were
  // withheld, they are requirements this revision and transport do not have.
  await reportUsage({
    failed: failed.map((item) => item.name),
    passed: passed.map((item) => item.name),
    notVerified: skipped.map((item) => item.name),
    specVersion: model.specVersion,
    transport: model.transport,
    serverName: process.env.MCP_SERVER_NAME,
  })
}
