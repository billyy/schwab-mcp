#!/usr/bin/env node
/**
 * check-tasks — the scheduled-task files in `tasks/` are the source of truth;
 * `~/.claude/scheduled-tasks/<name>/SKILL.md` is only an install of them.
 *
 * Why this exists: those installed files live outside git, so a PR that
 * changes what the CLI emits cannot touch them, and nothing fails when they
 * fall behind. That is not hypothetical — PR #18 (2026-08-18) added option
 * support across drift-diff, /orders, /proposals and the executor, while the
 * 10:00am task still said "never build option orders". It silently skipped a
 * live NFLX roll the next morning. The code was right and the job was stale,
 * and no test could see the gap because the job was not in the repo.
 *
 * So: `npm run validate` now fails when an installed task has drifted from its
 * repo copy. Runs on the machine that owns the tasks; a checkout that has
 * never installed them (CI, a fresh clone) is not a failure — there is nothing
 * to be stale.
 */
import {
	readFileSync,
	existsSync,
	readdirSync,
	realpathSync,
	lstatSync,
	readlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TASKS = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'tasks',
)
// Overridable so the check can be exercised against a fixture.
const INSTALL_ROOT =
	process.env.SCHEDULED_TASKS_ROOT ??
	join(homedir(), '.claude', 'scheduled-tasks')

const repoTasks = readdirSync(REPO_TASKS)
	.filter((f) => f.endsWith('.md'))
	.map((f) => ({ name: f.replace(/\.md$/, ''), path: join(REPO_TASKS, f) }))

if (!repoTasks.length) {
	console.error('✖ tasks/ is empty — expected at least one task definition')
	process.exit(1)
}

if (!existsSync(INSTALL_ROOT)) {
	console.log(
		`• ${INSTALL_ROOT} not present — tasks not installed here, skipping`,
	)
	process.exit(0)
}

const problems = []
const dangling = []
let linked = 0
let copied = 0
let absent = 0

for (const task of repoTasks) {
	const installed = join(INSTALL_ROOT, task.name, 'SKILL.md')
	// A dangling symlink is the dangerous case, not the harmless one: the job
	// is installed and scheduled, but its definition resolves to nothing, so
	// it fails at run time with no warning here. This happens for real when
	// the repo is on a branch that predates tasks/ — the link points into the
	// working tree, and checking out such a branch empties it. existsSync()
	// follows symlinks and reports false, which is indistinguishable from
	// "never installed" unless we look at the link itself.
	const link = lstatSync(installed, { throwIfNoEntry: false })
	if (link?.isSymbolicLink() && !existsSync(installed)) {
		dangling.push({
			name: task.name,
			installed,
			target: readlinkSync(installed),
			expected: task.path,
		})
		continue
	}
	if (!existsSync(installed)) {
		absent++
		continue
	}
	// A symlink back to the repo copy cannot drift at all — the strong form.
	if (realpathSync(installed) === realpathSync(task.path)) {
		linked++
		continue
	}
	copied++
	if (readFileSync(installed, 'utf8') !== readFileSync(task.path, 'utf8')) {
		problems.push({ name: task.name, repo: task.path, installed })
	}
}

if (dangling.length) {
	console.error(
		`✖ ${dangling.length} scheduled task(s) are installed but their definition is MISSING:\n`,
	)
	for (const d of dangling) {
		console.error(`  ${d.name}`)
		console.error(`    link:   ${d.installed}`)
		console.error(`    points at: ${d.target}  <-- does not exist`)
		if (d.target !== d.expected) {
			console.error(`    expected:  ${d.expected}`)
		}
	}
	console.error(
		'\nThese jobs are scheduled and WILL FAIL at run time. Usually the repo is\n' +
			'checked out on a branch where tasks/ does not exist yet — switch back to a\n' +
			'branch that has it (or merge the branch that adds it).',
	)
	process.exit(1)
}

if (problems.length) {
	console.error(
		`✖ ${problems.length} scheduled task(s) have drifted from their repo copy:\n`,
	)
	for (const p of problems) {
		console.error(`  ${p.name}`)
		console.error(`    repo:      ${p.repo}`)
		console.error(`    installed: ${p.installed}`)
		console.error(`    diff:      diff '${p.installed}' '${p.repo}'`)
	}
	console.error(
		'\nThe repo copy is authoritative. If the repo copy is right, reinstall:\n' +
			'  npm run tasks:install\n' +
			'If the installed copy has the newer edit, copy it back into tasks/ and commit it.',
	)
	process.exit(1)
}

const parts = [`${linked} linked`, `${copied} copied`]
if (absent) parts.push(`${absent} not installed`)
console.log(`✔ scheduled tasks in sync (${parts.join(', ')})`)
