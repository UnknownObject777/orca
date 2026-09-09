/**
 * Git-derived digests for ORM review evidence: HEAD revision plus a dirty-tree
 * digest, so uncommitted edits invalidate evidence even when HEAD is unchanged.
 * Git 2.25 baseline only (`rev-parse`, `status --porcelain=v1 -z`).
 */
import { createHash } from 'node:crypto'
import { runProcess } from '../../shared/child-process/run-process'

const GIT_TIMEOUT_MS = 15_000

async function gitStdout(worktreeRoot: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await runProcess({
      program: 'git',
      args: ['-c', 'core.untrackedCache=false', ...args],
      cwd: worktreeRoot,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: 4 * 1024 * 1024
    })
    if (result.code !== 0) {
      return null
    }
    return result.stdout
  } catch {
    return null
  }
}

export async function gitHeadRevision(worktreeRoot: string): Promise<string | null> {
  const out = await gitStdout(worktreeRoot, ['rev-parse', 'HEAD'])
  return out ? out.trim() : null
}

/** Digest of the porcelain state; identical trees digest identically. */
export async function gitDirtyDigest(worktreeRoot: string): Promise<string | null> {
  const out = await gitStdout(worktreeRoot, ['status', '--porcelain=v1', '-z'])
  if (out === null) {
    return null
  }
  return createHash('sha256').update(out).digest('hex')
}
