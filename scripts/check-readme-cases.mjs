#!/usr/bin/env node
// The README documents every case one by one. Documentation that lists 43 things
// is documentation that goes stale the first time someone adds a 44th, and a
// conformance tool whose docs quietly disagree with what it runs is worse than
// one that documents nothing — a reader would have no way to tell.
//
// So the list is checked rather than maintained by hand. This fails when a case
// exists without an entry, or an entry names a case that no longer exists.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const actual = new Set()
for (const file of readdirSync(join(root, 'tests')).filter((n) => n.endsWith('.test.mjs'))) {
  const src = readFileSync(join(root, 'tests', file), 'utf8')
  for (const m of src.matchAll(/\ntest\('([^']+)'/g)) actual.add(m[1])
}

const readme = readFileSync(join(root, 'README.md'), 'utf8')
const START = '## Every case, one by one'
const END = '### Assertions come from'
const from = readme.indexOf(START)
const to = readme.indexOf(END)
if (from === -1 || to === -1 || to < from) {
  console.error(`could not find the case list in README.md (looked for "${START}" then "${END}")`)
  process.exit(1)
}

// Entries are bullets whose first bold run is the case name, verbatim.
const documented = new Set(
  [...readme.slice(from, to).matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]),
)

const missing = [...actual].filter((name) => !documented.has(name))
const stale = [...documented].filter((name) => !actual.has(name))

if (missing.length || stale.length) {
  if (missing.length) {
    console.error(`${missing.length} case(s) are not documented in README.md:`)
    for (const name of missing) console.error(`  - ${name}`)
  }
  if (stale.length) {
    console.error(`${stale.length} README entr(ies) name a case that does not exist:`)
    for (const name of stale) console.error(`  - ${name}`)
  }
  process.exit(1)
}

console.log(`README documents all ${actual.size} cases`)
