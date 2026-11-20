# Janitor

**A nightly cleanup crew for your repository that never leaves it broken.**

Janitor finds dead files, unused exports, stale feature flags and outdated
minor/patch dependencies, then removes them **one verified step at a time**. After
every step it runs *your* typecheck, build and tests. Anything that breaks is rolled
back on the spot. You wake up to a pull request that lists exactly what was removed,
what was tried and reverted, and the commands to undo any of it.

```
[dead-files] 3 candidate(s)
[dead-files] reverted 3 item(s): npm test failed          <- one of them was load-bearing
[dead-files] kept 1 item(s) as 3c7de0479                  <- bisected: the safe ones survive
[dead-files] kept 1 item(s) as 1048a3a98
[unused-exports] kept 2 item(s) as 7df8529c3
[stale-flags] kept 1 item(s) as 29f8748a8
[outdated-deps] kept 1 item(s) as bd73a0ec0

Branch nightly-janitor/2026-11-20: 5 verified commit(s), 6 change(s) kept, 2 reverted.
Dead code removed: 403 B, 18 line(s).
```

## Quickstart

### As a nightly GitHub Action (recommended)

1. Copy [`examples/.github/workflows/nightly-janitor.yml`](examples/.github/workflows/nightly-janitor.yml)
   to `.github/workflows/nightly-janitor.yml` in your repository:

   ```yaml
   name: Nightly janitor
   on:
     schedule:
       - cron: '23 18 * * *' # 18:23 UTC daily
     workflow_dispatch: {}
   permissions:
     contents: write
     pull-requests: write
   concurrency:
     group: nightly-janitor
     cancel-in-progress: false
   jobs:
     janitor:
       runs-on: ubuntu-latest
       timeout-minutes: 90
       steps:
         - uses: actions/checkout@v5
           with:
             fetch-depth: 0
         - uses: actions/setup-node@v5
           with:
             node-version: 22
         - run: if [ -f package-lock.json ]; then npm ci; fi
         - uses: TwoMuchLabs/Janitor@main   # pin to a release tag once one is published
   ```

2. In **Settings -> Actions -> General -> Workflow permissions**, enable
   *Allow GitHub Actions to create and approve pull requests*.
3. Trigger it once from the **Actions** tab (*Run workflow*) to see your first PR.

> Pull requests opened with the default `GITHUB_TOKEN` do not trigger other workflows.
> The janitor has already run your suite on every commit, but if you want your CI
> checks on the PR too, pass a PAT or GitHub App token via the `token` input.

### From the command line

```bash
git clone https://github.com/TwoMuchLabs/Janitor && cd Janitor
npm ci && npm run build && npm link

cd /path/to/your/project
janitor scan     # dry run: list candidates, change nothing
janitor run      # do it: branch, apply, verify, commit or revert
```

`run` leaves you on `nightly-janitor/YYYY-MM-DD` with one commit per kept step and
writes the PR description to `.git/janitor/pr-body.md`:

```bash
git push -u origin HEAD
gh pr create --title "chore(janitor): nightly cleanup" --body-file .git/janitor/pr-body.md
```

Requires Node 20+ and git.

## How it stays safe

The core of the tool is the safe-apply loop in [`src/engine.ts`](src/engine.ts):

1. **Preconditions.** It refuses to start on a dirty working tree, when no
   verification command exists, or when the untouched code already fails
   verification (a failure could not be blamed on a step). In all three cases
   nothing is modified.
2. **Isolation.** All work happens on a new branch, `nightly-janitor/YYYY-MM-DD`.
   Your base branch is never touched and nothing is pushed by the CLI.
3. **One category at a time.** For each category: apply, stage, run the full
   verification suite, then either commit or `git reset --hard` + `git clean` back
   to the last verified commit.
4. **Bisect on failure.** If a category fails as a group, it is split in half and
   retried, so one load-bearing file cannot block the other deletions.
5. **Invariant.** Between steps the tree is clean and `HEAD` is a commit that
   passed verification. Every kept step is exactly one commit, so every step is
   individually revertible.

Other guard rails: changes are staged *before* tests run, so coverage reports or
build output can never leak into a commit; verification commands have a timeout
and kill the whole process tree; a nightly verification budget
(`maxVerifyRuns`) bounds CI minutes; and if nothing survives, the branch is deleted
and you are returned to where you started.

## What it cleans

| Category | Finds | Action |
| --- | --- | --- |
| `dead-files` | JS/TS files unreachable from every entry point | Deletes the file (with any dead files that import it) |
| `unused-exports` | Named exports no other module imports | Deletes the declaration (and imports only it used) if nothing else uses it and it has no side effects; otherwise just drops `export`. Files that satisfied prettier or biome are re-formatted |
| `stale-flags` | Flags in a JSON registry that nothing references | Removes the registry entry. Flags fully on for 90+ days are **reported**, not inlined |
| `outdated-deps` | npm, pnpm or Yarn 1 packages behind within their declared range | `npm update` / `pnpm update` / `yarn upgrade`, one package per step, lockfile only |

The analysis uses the TypeScript compiler's own module resolution, so `tsconfig`
`paths`, `.js` -> `.ts` specifiers and index files resolve as they do in your build.
It is deliberately biased towards leaving things alone:

- Entry points come from `package.json` (`main`, `module`, `exports`, `bin`,
  script arguments, mapped from the build directory back to source), from scripts an
  HTML page loads, and from the framework in use: Next.js, SvelteKit, Remix / React
  Router, Nuxt, Astro, Expo Router, React Native, Gatsby, NestJS, Angular, Docusaurus,
  VitePress and Storybook each contribute their route and entry files. Tests, fixtures, mock folders, `*.config.*`, dotfiles
  and `scripts/` always count as used.
- Any relative-path string that resolves to a source file counts as a use
  (`jest.mock('./x')`, `new Worker('./x.js')`, `new URL('./x.js', import.meta.url)`).
- ``import(`./locales/${lang}.js`)`` protects everything under `./locales/`; a fully
  dynamic `import(x)` / `require(x)` protects the importing file's directory.
- Files loaded by pattern or by listing a directory are kept: `import.meta.glob('./modules/*.ts')`,
  `require.context('./icons')`, `requireDirectory(__dirname)`, `fs.readdirSync(path.join(__dirname, 'tasks'))`.
- Vue, Svelte and Astro components are read for what they import, by name, and are always
  treated as in use. They are never edited or deleted themselves.
- In a project with automatic imports (Nuxt, unplugin-auto-import, unimport), an export
  whose name appears in any other file is kept, since it can be used there with no import.
- A file named in any non-code file (Dockerfile, workflow YAML, HTML, ...) or in the
  docs is kept, and an export whose name appears in a non-code file is kept.
- A file that nothing imports and that exports nothing is treated as a script someone runs
  by hand (`node tools/report.mjs`). It is listed in the PR, never deleted.
- A nested folder with its own `package.json` that is not a workspace of the root is a
  separate project your checks do not cover. Nothing inside it is touched.
- A platform or build variant of a sibling file (`md5-browser.ts` beside `md5.ts`,
  `Button.ios.tsx` beside `Button.tsx`) is kept: build scripts and bundlers swap these in
  by name, and tests on one platform do not notice another's variant missing.
- A wildcard in package.json `exports` (`"./unsafe/*": "./lib/*"`) publishes every file
  beneath it, so all of them are treated as public API. If the wildcard points into a build
  layout that cannot be traced back to source, the whole package is treated as public.
- Files at the top of the repository and tool files loaded by convention (`gulpfile.js`,
  `karma.conf.js`, `jest.setup.ts`) are never candidates.
- An export merged with a namespace of the same name is left alone.
- With no entry point at all, neither files nor exports are removed.
- Entry-point exports are public API and are never touched. Default exports are never touched.
- Major updates, and 0.x minor updates, are never applied; they are listed in the PR.

And when the analysis is still wrong, your test suite is the backstop: the step is reverted.

## The pull request

The generated description ([`src/report.ts`](src/report.ts)) contains:

- **Summary table** per category: items kept and reverted, bytes removed, lines deleted, commits.
- **Headline totals**: bytes and lines of dead code removed (lockfile churn is reported but not counted as dead code).
- **What changed**: every kept item, grouped by commit.
- **Reverted automatically**: every item that broke verification, with the failing command and its output.
- **Needs a human**: stale flags to inline, major updates, files held back.
- **Rollback**: exact commands with real shas.

```bash
# Undo a single step
git revert --no-edit 7df8529c3f0aeeb7ad4e9f4d4422bf3068fbb822   # Remove unused exports

# Undo everything before merge: close the PR, then delete the branch
git push origin --delete nightly-janitor/2026-11-20

# Undo everything after a merge-commit merge
git revert --no-edit 90447bebec51338f9e8b3945d4f3e6ad1f344d02..bd73a0ec09fc65b9022c64aa2c2e05093dce0750
```

A machine-readable `report.json` is written next to the PR body.

## Configuration

Everything is optional. Put a `.janitor.json` in the repository root:

```json
{
  "categories": ["dead-files", "unused-exports", "stale-flags", "outdated-deps"],
  "verify": ["npm run typecheck", "npm run build", "npm test"],
  "entry": ["src/workers/**", "src/lambda/*.ts"],
  "ignore": ["src/legacy/**"],
  "flags": { "registry": "config/flags.json", "staleDays": 90 },
  "deps": { "exclude": ["react"], "max": 20 },
  "bisect": true,
  "maxVerifyRuns": 25,
  "verifyTimeoutSec": 1200
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `categories` | all four | Which categories run, in order |
| `verify` | detected | Commands that must all pass. Detected from `package.json` scripts (`typecheck`, `build`, `check`, `test`), `Cargo.toml` or `go.mod` |
| `entry` | `[]` | Extra globs for files that are used without being imported |
| `ignore` | `[]` | Globs the janitor must never delete or edit (generated code, `dist/`, `vendor/` are ignored already) |
| `flags.registry` | detected | JSON object of flags (`flags.json`, `config/flags.json`, ...), optionally under a `flags` key |
| `flags.staleDays` | `90` | Age at which a fully-on flag is reported |
| `deps.exclude` / `deps.max` | `[]` / `20` | Packages to leave alone; updates attempted per night |
| `bisect` | `true` | Salvage safe items when a category fails |
| `maxVerifyRuns` | `25` | Cap on verification runs per night |
| `verifyTimeoutSec` | `1200` | Timeout per verification command |

### CLI

```
janitor run  [options]   Create nightly-janitor/YYYY-MM-DD and apply verified cleanups
janitor scan [options]   Dry run: list what would be attempted, change nothing

  --repo <path>            Repository to clean (default: current directory)
  --categories <list>      Comma-separated subset of the categories
  --verify <command>       Verification command; repeat for several
  --date <YYYY-MM-DD>      Date used in the branch name (default: today, UTC)
  --no-bisect              Revert a whole category on failure
  --max-verify-runs <n>    Verification budget for the night
  --timeout-sec <n>        Timeout per verification command
  --pr-body <file>         Where to write the PR description
  --report-json <file>     Where to write the JSON report
  --allow-unverified       Run with no verification command (not recommended)
```

Exit codes: `0` finished, `2` a precondition failed and nothing was touched, `1` error.

### Action inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `categories` | config, then all | Comma-separated categories |
| `verify` | detected | Verification commands, one per line |
| `working-directory` | `.` | Repository or package to clean |
| `open-pr` | `true` | Push the branch and open or update the PR |
| `base` | workflow branch | PR target branch |
| `labels` | none | Comma-separated labels (must exist) |
| `token` | `github.token` | Token for the push and PR |

Outputs: `changed`, `branch`, `pr-url`, `pr-body-file`, `report-file`.

## Project layout

```
Janitor/
├── action.yml                    composite GitHub Action (build, run, push, open PR)
├── examples/.github/workflows/
│   └── nightly-janitor.yml       copy-ready cron workflow
├── src/
│   ├── cli.ts                    argument parsing, output files, exit codes
│   ├── engine.ts                 the safe-apply + verify + revert + bisect loop
│   ├── verify.ts                 detects and runs the project's test/build/typecheck
│   ├── git.ts                    branch, stage, commit, restore, diff statistics
│   ├── exec.ts                   subprocess runner with timeout and process-group kill
│   ├── report.ts                 totals, PR description, dry-run plan
│   ├── config.ts                 .janitor.json loading and validation
│   ├── types.ts                  Category / CleanupItem / RunReport contracts
│   ├── analysis/
│   │   ├── module-graph.ts       import/export graph via the TypeScript compiler API
│   │   ├── entries.ts            entry-point discovery
│   │   ├── project.ts            reachability + out-of-graph "mentions"
│   │   └── imports.ts            removes imports left unused by a deletion
│   └── categories/
│       ├── dead-files.ts
│       ├── unused-exports.ts
│       ├── stale-flags.ts
│       └── outdated-deps.ts
└── test/                         node:test suites; engine tests run against real git repos
```

### Writing a category

A category is a read-only `scan` that returns independently applicable items. The
engine owns everything else: branching, verification, commits, reverts, bisecting
and reporting.

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { Category } from '@twomuchlabs/janitor';

export const removeTodoFiles: Category = {
  name: 'todo-files',
  title: 'Remove TODO scratch files',
  countsAsDeadCode: true,
  async scan(ctx) {
    const files = (await ctx.git.lsFiles()).filter((f) => f.endsWith('.todo'));
    return {
      notes: [],
      items: files.map((f) => ({
        id: `todo:${f}`,
        description: `delete \`${f}\``,
        apply: async (c) => fs.promises.rm(path.join(c.root, f)),
      })),
    };
  },
};
```

## How it has been tested

Besides its unit tests, Janitor has been dry-run on its own code, on four Two Much Labs
repositories and on twenty-two public projects of different shapes:

| Shape | Projects |
|---|---|
| Libraries | express, commander.js, axios, ky, uuid, yup, fastify |
| Monorepos | zod (pnpm), excalidraw (Yarn 1 workspaces) |
| React and React Native apps | vercel/commerce (Next.js), a React Native / Expo template |
| Vue and Nuxt apps | nuxt/movies, elk (Nuxt 4), vitesse, vue-pure-admin |
| Svelte apps | sveltejs/realworld, learn.svelte.dev (SvelteKit) |
| Angular and NestJS | angular-realworld-example-app, nestjs-realworld-example-app |
| Services and tools | pm2 (CommonJS), pocketbase's admin UI (run from a sub-folder) |
| Large application | outline (about 2,500 source files, scanned in a few seconds) |

Nothing was sent to those projects.

Those runs are where most of the rules above came from. Thirteen times it proposed
something the project's own tests would probably not have caught:

- scripts run by hand (a lab repo)
- files a build swaps in by name (uuid)
- files published through a wildcard export (axios, excalidraw)
- a tool file loaded by convention (axios)
- a compiler fixture (zod)
- a nested package outside the checks (a lab repo)
- exports judged without knowing the entry point (ky)
- modules loaded by `import.meta.glob` (vitesse)
- thirty queue processors and tasks loaded by listing their directory (outline)
- a documentation theme override (excalidraw)
- types used through Nuxt's automatic imports, with no import statement (elk)
- files imported only from Vue components (vue-pure-admin)
- mock-server files loaded by folder convention (vue-pure-admin)

Each is now a rule with a regression test. Where its remaining findings were checked
by hand (ky, vercel/commerce, the React Native template, Sarvavox, elk, and samples
from outline, excalidraw, yup and vue-pure-admin) they were correct.

Most of this was dry runs checked by hand. Its changes have also been run through a
project's own checks on six codebases:

| Project | Changes kept | Checked with |
|---|---|---|
| Sarvavox (lab, on GitHub) | 2 unused exports | its build and check scripts; merged |
| ky | 11 unused exports | lint, build, typecheck |
| axios | dependency updates | build and unit tests |
| vercel/commerce | 10 unused exports | typecheck; changed files pass its formatter |
| excalidraw | 5 unused exports | typecheck, formatter, and its linter on the changed files |
| vitesse | 19 pnpm dependency updates | typecheck; one update that failed to install was isolated and reverted |

These were run in a sandbox without a browser or open network access, so browser
tests, and test files or builds that fetch from the network, were left out. None of
the six is a full run of a project's complete suite except Sarvavox.

Twenty-six codebases is still a small sample, and new shapes kept turning up new
mistakes to the end: treat its pull requests as proposals to review, not as changes
to merge unread.

## Limitations (v0.1)

- Dead-file and unused-export analysis covers JavaScript and TypeScript. Other
  languages still get `stale-flags` and whatever verification you configure.
- One root `tsconfig.json` is used for resolution. Monorepos work when packages
  import each other through workspace links; per-package `paths` are not read yet.
  Nested packages that are not workspaces are skipped; run janitor in each with `working-directory`.
- `export { a, b }` lists, `export default` and CommonJS `module.exports` are not pruned.
- When a declaration is deleted, imports that only it used are removed too. A value import
  that loses every name is reduced to `import 'module'` rather than deleted, so the module
  is still loaded; you may want to delete that line by hand.
- Only prettier and biome are recognised for re-formatting edited files.
- Dependency updates support npm (`package-lock.json`), pnpm (`pnpm-lock.yaml`) and Yarn 1
  (`yarn.lock`), at the repository root only. Yarn 2 and later, and Bun, are skipped. With pnpm the PR states the newest
  version available; the update stops wherever the declared range ends.
- Flag registries must be JSON. Flags defined in code or in a hosted service are not detected.
- The janitor is only as safe as your verification suite. Code that no test, build
  or typecheck exercises can be removed without anything failing; review the PR.

## Development

```bash
npm ci
npm run typecheck
npm test          # 61 tests; the engine suite drives real temporary git repositories
npm run build
```

## License

MIT
