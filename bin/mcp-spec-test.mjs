#!/usr/bin/env node
// The command-line entry point.
//
//   npx @hasmcp/mcp-spec-test@latest -u https://example.com/mcp -t <token>
//   npx @hasmcp/mcp-spec-test@latest -c "npx -y @modelcontextprotocol/server-everything"
//
// Every flag has an environment-variable twin, and flags win over the
// environment, so the same run is expressible either way — a flag for a one-off
// check, env vars for CI where a token should not appear in a command line or
// process list.
//
// The suite itself is plain node:test, so this wrapper does one thing: turn
// arguments into the environment the tests read, then run them under the
// conformance reporter.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// flag → environment variable. Long and short forms both land here.
const FLAGS = {
  '--url': 'MCP_URL',
  '-u': 'MCP_URL',
  '--command': 'MCP_COMMAND',
  '-c': 'MCP_COMMAND',
  '--token': 'MCP_TOKEN',
  '-t': 'MCP_TOKEN',
  '--auth-mode': 'MCP_AUTH_MODE',
  '--auth-header': 'MCP_AUTH_HEADER',
  '--auth-scheme': 'MCP_AUTH_SCHEME',
  '--auth-query-param': 'MCP_AUTH_QUERY_PARAM',
  '--header': 'MCP_EXTRA_HEADERS',
  '-H': 'MCP_EXTRA_HEADERS',
  '--spec-version': 'MCP_SPEC_VERSION',
  '--spec-path': 'MCP_SPEC_PATH',
  '--default-version': 'MCP_SERVER_DEFAULT_VERSION',
  '--stream-budget-ms': 'MCP_STREAM_BUDGET_MS',
  '--tool-args': 'MCP_TOOL_ARGS',
  '--prompt-args': 'MCP_PROMPT_ARGS',
  '--resource-sample': 'MCP_RESOURCE_SAMPLE',
  '--page-limit': 'MCP_PAGE_LIMIT',
}

const USAGE = `
${pkg.name} ${pkg.version} — conformance test any MCP server against the current spec

Usage
  npx ${pkg.name}@latest -u <url> [options]
  npx ${pkg.name}@latest -c "<command to spawn>" [options]

Target (one is required)
  -u, --url <url>              Streamable HTTP endpoint            [MCP_URL]
  -c, --command <cmd>          command to spawn and speak stdio to [MCP_COMMAND]

Credentials
  -t, --token <token>          bearer token                        [MCP_TOKEN]
      --auth-mode <mode>       header | query | none (default header)
                                                                   [MCP_AUTH_MODE]
      --auth-header <name>     header carrying the token (default authorization)
                                                                   [MCP_AUTH_HEADER]
      --auth-scheme <scheme>   token prefix (default "Bearer"; "" for a bare token)
                                                                   [MCP_AUTH_SCHEME]
      --auth-query-param <k>   query parameter in query mode (default token)
                                                                   [MCP_AUTH_QUERY_PARAM]
  -H, --header <list>          extra headers, "k: v, k2: v2"       [MCP_EXTRA_HEADERS]

Suite
      --spec-version <date>    revision to test; one of the supported window
                               (default 2026-07-28)                [MCP_SPEC_VERSION]
      --spec-path <file>       schema.json to assert against, instead of the
                               vendored copy                       [MCP_SPEC_PATH]
      --default-version <date> the version the server negotiates for a client
                               that declares none; probed if omitted
                                                                   [MCP_SERVER_DEFAULT_VERSION]
      --stream-budget-ms <ms>  how long streaming cases wait (default 4000)
                                                                   [MCP_STREAM_BUDGET_MS]

Opting in to calls the suite will not guess at
      --tool-args <json>       arguments per tool, '{"search":{"query":"x"}}'.
                               Without this, tools with required arguments are
                               skipped rather than called with invented values
                                                                   [MCP_TOOL_ARGS]
      --prompt-args <json>     arguments per prompt, same shape   [MCP_PROMPT_ARGS]
      --resource-sample <n>    how many listed resources to read (default 5)
                                                                   [MCP_RESOURCE_SAMPLE]
      --page-limit <n>         pages to follow before calling pagination broken
                               (default 10)                        [MCP_PAGE_LIMIT]
      --only <pattern>         run only test files matching a substring
      --verbose                also print the target's own stderr    [MCP_VERBOSE]
      --tap                    raw TAP instead of the report, for CI parsing
  -h, --help                   this message
  -v, --version                print the version

Supported revisions: 2026-07-28, 2025-11-25. Only these two are reasoned about;
an older revision a server advertises is reported as out of scope, not judged.

Flags override the environment, so either style works and CI can keep the token
out of the process list.

Exit code is 0 when nothing failed. Skipped cases do not fail the run, but they
are listed as NOT VERIFIED — a skip is not a pass.
`

const env = { ...process.env }
let only = null
let tap = false
const argv = process.argv.slice(2)

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]

  if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  if (arg === '-v' || arg === '--version') {
    process.stdout.write(`${pkg.version}\n`)
    process.exit(0)
  }
  if (arg === '--verbose') {
    env.MCP_VERBOSE = '1'
    continue
  }
  if (arg === '--tap') {
    tap = true
    continue
  }
  if (arg === '--only') {
    only = argv[++i]
    continue
  }

  // --url=value as well as --url value, since both are muscle memory.
  const eq = arg.indexOf('=')
  const name = eq === -1 ? arg : arg.slice(0, eq)
  const key = FLAGS[name]
  if (!key) {
    process.stderr.write(`unknown option: ${arg}\n${USAGE}\n`)
    process.exit(2)
  }
  const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
  if (value === undefined) {
    process.stderr.write(`${name} needs a value\n`)
    process.exit(2)
  }
  env[key] = value
}

if (!env.MCP_URL && !env.MCP_COMMAND) {
  process.stderr.write(`no target: pass -u <url> or -c "<command>" (or set MCP_URL / MCP_COMMAND)\n${USAGE}\n`)
  process.exit(2)
}
if (env.MCP_URL && env.MCP_COMMAND) {
  process.stderr.write('pass either a url or a command, not both — they select different transports\n')
  process.exit(2)
}

const pattern = only ? `tests/**/*${only}*.test.mjs` : 'tests/**/*.test.mjs'
const args = ['--test']
args.push(tap ? '--test-reporter=tap' : `--test-reporter=${join(root, 'lib', 'reporter.mjs')}`)
args.push(pattern)

const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
