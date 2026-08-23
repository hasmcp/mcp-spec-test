// This package's own version, read once from package.json rather than
// duplicated as a literal in every module that identifies itself to a target
// server (lib/rpc.mjs, lib/session.mjs) — a literal that has drifted from the
// real version before, silently, since nothing checks it against anything.
//
// Not the name: the clientInfo callers send is deliberately the short
// 'mcp-spec-test', not package.json's scoped "@hasmcp/mcp-spec-test", so that
// stays a literal at each call site rather than living here.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

export { version }
