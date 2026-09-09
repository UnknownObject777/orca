/**
 * Read side of the ORM review feature: config discovery, the three-view
 * status assembly, evidence views with computed staleness, and run
 * preparation. Execution lives in orm-review-execution.ts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  OrmReviewConfigDescriptor,
  OrmReviewEvidenceRecord,
  OrmReviewEvidenceView,
  OrmReviewMigrationEntry,
  OrmReviewRunPreparation,
  OrmReviewStatusResult
} from '../../shared/orm-review'
import {
  discoverPrismaConfigs,
  listPrismaMigrations,
  parsePrismaModelNames,
  PRISMA_CAPABILITIES,
  prismaInputDigest
} from './prisma-adapter'
import { parseMigrateStatusOutput } from './prisma-commands'
import { resolveOrmReviewDeps, type OrmReviewDepsInput } from './orm-review-service-deps'
import type { OrmReviewRegisteredTarget } from './orm-review-targets'

export class OrmReviewService {
  private readonly deps
  /** Records left `running` from before this process started are interrupted. */
  private readonly processStartedAt: number

  constructor(deps: OrmReviewDepsInput) {
    this.deps = resolveOrmReviewDeps(deps)
    this.processStartedAt = this.deps.now()
  }

  async discoverConfigs(worktreeRoot: string): Promise<OrmReviewConfigDescriptor[]> {
    return discoverPrismaConfigs(worktreeRoot)
  }

  private async resolveConfig(
    worktreeRoot: string,
    configId: string | null
  ): Promise<OrmReviewConfigDescriptor | null> {
    const configs = await this.discoverConfigs(worktreeRoot)
    if (configs.length === 0) {
      return null
    }
    if (configId) {
      return configs.find((c) => c.configId === configId) ?? null
    }
    return configs[0]
  }

  async currentInputs(worktreeRoot: string, config: OrmReviewConfigDescriptor) {
    const migrations = await listPrismaMigrations(worktreeRoot, config.schemaPath)
    const inputDigest = await prismaInputDigest(worktreeRoot, config.schemaPath, migrations)
    return { migrations, inputDigest }
  }

  private evidenceViews(
    records: OrmReviewEvidenceRecord[],
    current: { inputDigest: string; gitRevision: string | null; dirtyDigest: string | null }
  ): OrmReviewEvidenceView[] {
    return records.map((record) => {
      // A `running` record older than this process is an interrupted run —
      // surface it as unknown until reconcileInterrupted re-reads history.
      if (record.state === 'running' && record.startedAt < this.processStartedAt) {
        return { ...record, effectiveState: 'unknown' as const }
      }
      const stale =
        (record.state === 'passed' || record.state === 'failed') &&
        (record.inputDigest !== current.inputDigest ||
          record.gitRevision !== current.gitRevision ||
          record.dirtyDigest !== current.dirtyDigest)
      return { ...record, effectiveState: stale ? ('stale' as const) : record.state }
    })
  }

  async getStatus(args: {
    worktreeId: string
    worktreeRoot: string
    configId?: string | null
    targetId?: string | null
  }): Promise<OrmReviewStatusResult> {
    const configs = await this.discoverConfigs(args.worktreeRoot)
    const config = await this.resolveConfig(args.worktreeRoot, args.configId ?? null)
    const targets = this.deps.targets.list(args.worktreeId)
    const target = args.targetId
      ? this.deps.targets.resolve(args.worktreeId, args.targetId)
      : null

    if (!config) {
      return {
        worktreeId: args.worktreeId,
        runtimeId: this.deps.runtimeId,
        selectedConfigId: null,
        configs,
        capabilities: PRISMA_CAPABILITIES,
        declaredModel: { state: 'unknown', reason: 'no-supported-orm-config' },
        migrationHistory: { state: 'unknown', reason: 'no-supported-orm-config' },
        observedDatabase: { state: 'unknown', reason: 'no-supported-orm-config' },
        targets,
        evidence: []
      }
    }

    const { migrations, inputDigest } = await this.currentInputs(args.worktreeRoot, config)
    const [gitRevision, dirtyDigest] = await Promise.all([
      this.deps.headRevision(args.worktreeRoot),
      this.deps.dirtyDigest(args.worktreeRoot)
    ])

    let declaredModel: OrmReviewStatusResult['declaredModel']
    try {
      const schema = await readFile(join(args.worktreeRoot, config.schemaPath), 'utf8')
      declaredModel = {
        state: 'ok',
        schemaPath: config.schemaPath,
        modelNames: parsePrismaModelNames(schema),
        inputDigest
      }
    } catch {
      declaredModel = { state: 'unknown', reason: 'schema-unreadable' }
    }

    const records = (await this.deps.store.list(args.worktreeId)).filter(
      (r) => r.configId === config.configId
    )
    const evidence = this.evidenceViews(records, { inputDigest, gitRevision, dirtyDigest })
    const observedDatabase = this.observedDatabase(target, records, migrations)
    const historyEntries: OrmReviewMigrationEntry[] = migrations.map((m) => {
      if (observedDatabase.state !== 'ok') {
        return m
      }
      if (observedDatabase.appliedMigrations.includes(m.name)) {
        return { ...m, status: 'applied' }
      }
      if (observedDatabase.pendingMigrations.includes(m.name)) {
        return { ...m, status: 'pending' }
      }
      return m
    })

    return {
      worktreeId: args.worktreeId,
      runtimeId: this.deps.runtimeId,
      selectedConfigId: config.configId,
      configs,
      capabilities: PRISMA_CAPABILITIES,
      declaredModel,
      migrationHistory: { state: 'ok', entries: historyEntries, inputDigest },
      observedDatabase,
      targets,
      evidence
    }
  }

  /**
   * The observed-database view comes from the most recent passing status run
   * against this target — the Prisma adapter reports introspection as
   * unsupported rather than fabricating a schema comparison.
   */
  private observedDatabase(
    target: OrmReviewRegisteredTarget | null,
    records: OrmReviewEvidenceRecord[],
    migrations: readonly OrmReviewMigrationEntry[]
  ): OrmReviewStatusResult['observedDatabase'] {
    if (!target) {
      return { state: 'unknown', reason: 'no-target-selected' }
    }
    const lastStatus = records
      .filter(
        (r) =>
          r.kind === 'schema-checked' &&
          r.targetIdentityHash === target.identityHash &&
          r.state === 'passed' &&
          r.endedAt !== null
      )
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
    if (!lastStatus) {
      return { state: 'unknown', reason: 'never-observed' }
    }
    const parsed = parseMigrateStatusOutput(lastStatus.outputTail, migrations)
    if (!parsed) {
      return { state: 'unknown', reason: 'status-output-unparseable' }
    }
    return {
      state: 'ok',
      target: {
        targetId: target.targetId,
        label: target.label,
        redactedUrl: target.redactedUrl,
        identityHash: target.identityHash
      },
      observedAt: lastStatus.endedAt ?? lastStatus.startedAt,
      appliedMigrations: parsed.applied,
      pendingMigrations: parsed.pending
    }
  }

  async listEvidence(worktreeId: string): Promise<OrmReviewEvidenceRecord[]> {
    return this.deps.store.list(worktreeId)
  }

  /** Prepare a run: capture the digests the runtime will recheck before executing. */
  async prepareRun(args: {
    worktreeId: string
    worktreeRoot: string
    configId: string
    targetId: string
  }): Promise<OrmReviewRunPreparation | { rejected: 'unknown-target' | 'unknown-config' }> {
    const config = await this.resolveConfig(args.worktreeRoot, args.configId)
    if (!config) {
      return { rejected: 'unknown-config' }
    }
    const target = this.deps.targets.resolve(args.worktreeId, args.targetId)
    if (!target) {
      return { rejected: 'unknown-target' }
    }
    const { inputDigest } = await this.currentInputs(args.worktreeRoot, config)
    return { inputDigest, targetIdentityHash: target.identityHash }
  }
}
