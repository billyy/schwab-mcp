#!/usr/bin/env node
/**
 * install-tasks — symlink `~/.claude/scheduled-tasks/<name>/SKILL.md` at the
 * repo's `tasks/<name>.md`, so the running job and the reviewed file are the
 * same bytes and cannot drift. Idempotent; --check reports without writing.
 *
 * A symlink rather than a copy on purpose: a copy needs re-running after every
 * edit, and forgetting is the exact failure this is here to prevent.
 */
import {
	existsSync,
	readdirSync,
	realpathSync,
	renameSync,
	symlinkSync,
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
const INSTALL_ROOT = join(homedir(), '.claude', 'scheduled-tasks')
const checkOnly = process.argv.includes('--check')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let changed = 0

for (const file of readdirSync(REPO_TASKS).filter((f) => f.endsWith('.md'))) {
	const name = file.replace(/\.md$/, '')
	const source = join(REPO_TASKS, file)
	const dir = join(INSTALL_ROOT, name)
	const target = join(dir, 'SKILL.md')

	if (existsSync(target) && realpathSync(target) === realpathSync(source)) {
		console.log(`• ${name}: already linked`)
		continue
	}
	if (checkOnly) {
		console.log(`! ${name}: NOT linked (would install)`)
		changed++
		continue
	}
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
		// Never delete the previous definition — move it aside, dated.
		const backup = `${target}.replaced-${stamp}.bak`
		renameSync(target, backup)
		console.log(`  previous copy kept at ${backup}`)
	}
	symlinkSync(source, target)
	console.log(`✔ ${name}: linked → ${source}`)
	changed++
}

if (checkOnly && changed) process.exit(1)
console.log(changed ? `\n${changed} task(s) updated.` : '\nNothing to do.')
