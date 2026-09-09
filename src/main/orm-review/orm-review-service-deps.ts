/**
 * Shared dependency contract for the ORM review read (service) and write
 * (execution) sides. Everything is injected so the feature's single test seam
 * can substitute fakes — no real database, git, or Prisma in unit tests.
 */
import type { OrmReviewEvidenceStore } from './orm-review-evidence-store'
import type { OrmReviewTargetRegistry } from './orm-review-targets'
import type { OrmReviewCommandRunner } from './prisma-commands'
import { gitDirtyDigest, gitHeadRevision } from './orm-review-digests'

export type OrmReviewDeps = {
  store: OrmReviewEvidenceStore
  targets: OrmReviewTargetRegistry
  runCommand: OrmReviewCommandRunner
  runtimeId: string
  now: () => number
  headRevision: (worktreeRoot: string) => Promise<string | null>
  dirtyDigest: (worktreeRoot: string) => Promise<string | null>
}

export type OrmReviewDepsInput = Partial<
  Pick<OrmReviewDeps, 'now' | 'headRevision' | 'dirtyDigest'>
> &
  Pick<OrmReviewDeps, 'store' | 'targets' | 'runCommand' | 'runtimeId'>

export function resolveOrmReviewDeps(input: OrmReviewDepsInput): OrmReviewDeps {
  return {
    ...input,
    now: input.now ?? Date.now,
    headRevision: input.headRevision ?? gitHeadRevision,
    dirtyDigest: input.dirtyDigest ?? gitDirtyDigest
  }
}
