/**
 * Wire contract for the worktree ORM schema/migration review surface
 * (spec: stablyai/orca#19711 + #19714). Additive-only: extend with new
 * optional fields, never retype existing ones (remote-wire-compatibility).
 *
 * Nothing in this file may carry connection secrets — targets cross the wire
 * as redacted descriptors; URLs stay runtime-side.
 */

export const ORM_REVIEW_EVIDENCE_SCHEMA_VERSION = 1 as const

export type OrmReviewOrm = 'prisma'

export type OrmReviewCapability =
  | 'discovery'
  | 'history'
  | 'introspection'
  | 'planning'
  | 'verification'

/** A detected ORM project config the developer can explicitly select. */
export type OrmReviewConfigDescriptor = {
  /** Stable id derived from the worktree-relative schema path. */
  configId: string
  orm: OrmReviewOrm
  /** Worktree-relative path of the schema file. */
  schemaPath: string
  /** Worktree-relative directory commands run in. */
  projectDir: string
  displayName: string
}

/** Wire-safe view of a database target; the URL never leaves the runtime. */
export type OrmReviewTargetDescriptor = {
  targetId: string
  /** Developer-supplied label, e.g. "bookmarks-dev". */
  label: string
  /** Credentials masked, e.g. postgresql://user:****@host:5432/db. */
  redactedUrl: string
  /** sha256 of the normalized URL; distinguishes targets without exposing them. */
  identityHash: string
}

export type OrmReviewMigrationStatus = 'applied' | 'pending' | 'unknown'

export type OrmReviewMigrationEntry = {
  name: string
  /** Worktree-relative path of the migration directory or file. */
  relativePath: string
  status: OrmReviewMigrationStatus
  /** Heuristic: migration SQL contains a potentially destructive operation. */
  destructive: boolean
}

export type OrmReviewEvidenceKind = 'migration-applied' | 'schema-checked' | 'app-tests-passed'

/**
 * Persisted states; `stale` is never stored — it is computed by comparing the
 * record's input digests against the worktree's current inputs.
 */
export type OrmReviewStoredEvidenceState =
  | 'running'
  | 'passed'
  | 'failed'
  | 'unknown'
  | 'reconciling'

export type OrmReviewEvidenceState = OrmReviewStoredEvidenceState | 'stale'

export type OrmReviewEvidenceRecord = {
  evidenceId: string
  worktreeId: string
  configId: string
  kind: OrmReviewEvidenceKind
  state: OrmReviewStoredEvidenceState
  /** HEAD at execution time; null when git was unavailable. */
  gitRevision: string | null
  /** Digest of the dirty worktree state; changes invalidate evidence even at the same HEAD. */
  dirtyDigest: string | null
  /** Digest of the model + migration file contents the run observed. */
  inputDigest: string
  toolVersion: string | null
  targetId: string | null
  /** Redacted target label safe to show and send to agents. */
  targetLabel: string | null
  targetIdentityHash: string | null
  /** Human-readable command, e.g. "prisma migrate dev". */
  commandLabel: string
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  /** Bounded and credential-redacted. */
  outputTail: string
  outputTruncated: boolean
}

export type OrmReviewEvidenceView = OrmReviewEvidenceRecord & {
  /** Stored state with `stale` applied when current inputs no longer match. */
  effectiveState: OrmReviewEvidenceState
}

/** One of the three independent review views; never fabricate a clean comparison. */
export type OrmReviewViewState<T> =
  | ({ state: 'ok' } & T)
  | { state: 'unsupported'; reason: string }
  | { state: 'unknown'; reason: string }
  | { state: 'unavailable'; reason: string }

export type OrmReviewDeclaredModel = {
  schemaPath: string
  modelNames: string[]
  inputDigest: string
}

export type OrmReviewHistory = {
  entries: OrmReviewMigrationEntry[]
  inputDigest: string
}

export type OrmReviewObservedDatabase = {
  target: OrmReviewTargetDescriptor
  observedAt: number
  appliedMigrations: string[]
  pendingMigrations: string[]
}

export type OrmReviewStatusResult = {
  worktreeId: string
  runtimeId: string
  selectedConfigId: string | null
  configs: OrmReviewConfigDescriptor[]
  capabilities: Record<OrmReviewCapability, 'supported' | 'unsupported'>
  declaredModel: OrmReviewViewState<OrmReviewDeclaredModel>
  migrationHistory: OrmReviewViewState<OrmReviewHistory>
  observedDatabase: OrmReviewViewState<OrmReviewObservedDatabase>
  targets: OrmReviewTargetDescriptor[]
  evidence: OrmReviewEvidenceView[]
}

export type OrmReviewCommandKind =
  | 'migrate-status'
  | 'migrate-dev'
  | 'migrate-deploy'
  | 'validate'

/** Client preparation for a run; the runtime rechecks both digests before executing. */
export type OrmReviewRunPreparation = {
  inputDigest: string
  targetIdentityHash: string
}

export type OrmReviewRunResult = {
  records: OrmReviewEvidenceRecord[]
  rejected?: 'stale-preparation' | 'unknown-target' | 'unknown-config'
}

/** Bounded, credential-free context packet for send-to-agent. */
export type OrmReviewContextPacket = {
  scope: { worktreeId: string; targetLabel: string | null; runtimeId: string }
  source: { kind: 'evidence' | 'schema-difference'; referenceId: string; capturedAt: number }
  evidenceText: string
  userRequest: string
  limits: { truncated: boolean; omitted: string[] }
  /** Fully rendered, delimited text body ready for the agent prompt. */
  renderedText: string
}

export const ORM_REVIEW_PACKET_MAX_BYTES = 16 * 1024
export const ORM_REVIEW_OUTPUT_TAIL_MAX_BYTES = 8 * 1024
