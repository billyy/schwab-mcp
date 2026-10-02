#!/usr/bin/env node
/**
 * install-tasks — copy the repo's `tasks/<name>.md` to
 * `~/.claude/scheduled-tasks/<name>/SKILL.md`. Idempotent; --check reports
 * without writing.
 *
 * A COPY, not a symlink. The first version symlinked the installed file at the
 * repo copy so the two could never drift. Since 2026-09-03 the desktop app
 * rejects a SKILL.md that resolves outside `~/.claude/scheduled-tasks`
 * ("Invalid file path: path traversal detected"): the registration cannot be
 * updated and, worse, the scheduled run no longer starts a session at all —
 * the task shows a fresh `lastRunAt` and nothing happens. Both CRT tasks were
 * dark 2026-09-29 → 10-01 after a reinstall re-created the links (PR #21).
 *
 * Drift is caught instead by `npm run tasks:check` (part of `npm run validate`),
 * which compares bytes. Re-run this after every edit to `tasks/*.md`.
 */
import {
	existsSync,
	readdirSync,
	readFileSync,
	copyFileSync,
	renameSync,
	unlinkSync,
	mkdirSync,
	lstatSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TASKS = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'tasks',
)
// Overridable so the install can be exercised against a fixture.
const INSTALL_ROOT =
	process.env.SCHEDULED_TASKS_ROOT ??
	join(homedir(), '.claude', 'scheduled-tasks')
const checkOnly = process.argv.includes('--check')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let changed = 0

for (const file of readdirSync(REPO_TASKS).filter((f) => f.endsWith('.md'))) {
	const name = file.replace(/\.md$/, '')
	const source = join(REPO_TASKS, file)
	const dir = join(INSTALL_ROOT, name)
	const target = join(dir, 'SKILL.md')

	const current = lstatSync(target, { throwIfNoEntry: false })
	const isLink = current?.isSymbolicLink() ?? false
	// trimEnd: the desktop app drops the trailing newline when it rewrites the
	// installed file's frontmatter (description edits) — not a real difference.
	const upToDate =
		current &&
		!isLink &&
		readFileSync(target, 'utf8').trimEnd() ===
			readFileSync(source, 'utf8').trimEnd()

	if (upToDate) {
		console.log(`• ${name}: already installed`)
		continue
	}
	if (checkOnly) {
		console.log(
			isLink
				? `! ${name}: installed as a SYMLINK — the scheduler rejects it (would replace with a copy)`
				: current
					? `! ${name}: installed copy differs from tasks/${file} (would reinstall)`
					: `! ${name}: NOT installed (would install)`,
		)
		changed++
		continue
	}
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	if (isLink) {
		// A link holds no content of its own — nothing to preserve.
		unlinkSync(target)
		console.log(`  removed symlink (the scheduler rejects a linked SKILL.md)`)
	} else if (current) {
		// Never delete the previous definition — move it aside, dated.
		const backup = `${target}.replaced-${stamp}.bak`
		renameSync(target, backup)
		console.log(`  previous copy kept at ${backup}`)
	}
	copyFileSync(source, target)
	console.log(`✔ ${name}: copied ← ${source}`)
	changed++
}

if (checkOnly && changed) process.exit(1)
console.log(changed ? `\n${changed} task(s) updated.` : '\nNothing to do.')
