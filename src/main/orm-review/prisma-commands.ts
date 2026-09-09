/**
 * Prisma command table and output parsing for ORM review execution.
 */
import {
  ORM_REVIEW_OUTPUT_TAIL_MAX_BYTES,
  type OrmReviewCommandKind,
  type OrmReviewEvidenceKind,
  type OrmReviewMigrationEntry
} from '../../shared/orm-review'
import type { ProcessResult } from '../../shared/child-process/process-spec'
import { join } from 'node:path'

export type OrmReviewCommandRunner = (args: {
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}) => Promise<ProcessResult>

/**
 * The project's own Prisma CLI as an absolute node_modules/.bin path, so
 * Windows resolves the .cmd shim inside the spawn chokepoint — a bare `npx`
 * would need a PATH lookup and a cmd.exe wrapper the boundary forbids.
 */
export function prismaCliProgram(worktreeRoot: string, projectDir: string): string {
  const bin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
  return join(worktreeRoot, projectDir, 'node_modules', '.bin', bin)
}

export const PRISMA_COMMANDS: Record<
  OrmReviewCommandKind,
  { label: string; args: string[]; kind: OrmReviewEvidenceKind }
> = {
  'migrate-status': {
    label: 'prisma migrate status',
    args: ['migrate', 'status'],
    kind: 'schema-checked'
  },
  'migrate-dev': {
    label: 'prisma migrate dev',
    args: ['migrate', 'dev'],
    kind: 'migration-applied'
  },
  'migrate-deploy': {
    label: 'prisma migrate deploy',
    args: ['migrate', 'deploy'],
    kind: 'migration-applied'
  },
  validate: { label: 'prisma validate', args: ['validate'], kind: 'schema-checked' }
}

export function tailOutput(text: string): { tail: string; truncated: boolean } {
  if (text.length <= ORM_REVIEW_OUTPUT_TAIL_MAX_BYTES) {
    return { tail: text, truncated: false }
  }
  return { tail: text.slice(text.length - ORM_REVIEW_OUTPUT_TAIL_MAX_BYTES), truncated: true }
}

/** Parse `prisma migrate status` output into applied/pending migration names. */
export function parseMigrateStatusOutput(
  output: string,
  known: readonly OrmReviewMigrationEntry[]
): { applied: string[]; pending: string[] } | null {
  const pending: string[] = []
  const pendingSection = output.match(
    /following migrations? (?:have|has) not yet been applied:?\s*([\s\S]*?)(?:\n\s*\n|$)/i
  )
  if (pendingSection) {
    for (const line of pendingSection[1].split('\n')) {
      const name = line.trim()
      if (name) {
        pending.push(name)
      }
    }
  }
  if (/up to date|already in sync|no pending migrations/i.test(output) && pending.length === 0) {
    return { applied: known.map((m) => m.name), pending: [] }
  }
  if (pending.length === 0 && !pendingSection) {
    return null
  }
  const pendingSet = new Set(pending)
  return {
    applied: known.filter((m) => !pendingSet.has(m.name)).map((m) => m.name),
    pending
  }
}
