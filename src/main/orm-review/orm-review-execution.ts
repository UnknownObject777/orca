/**
 * Write side of the ORM review feature: serialized command execution with
 * pre-execution rechecks, separate post-checks, and reconciliation of
 * interrupted operations. Read-side status assembly lives in
 * orm-review-service.ts.
 */
import { join } from 'node:path'
import type {
  OrmReviewCommandKind,
  OrmReviewConfigDescriptor,
  OrmReviewEvidenceRecord,
  OrmReviewRunPreparation,
  OrmReviewRunResult
} from '../../shared/orm-review'
import type { ProcessResult } from '../../shared/child-process/process-spec'
import { redactSecretsFromText } from './orm-review-redaction'
import type { OrmReviewService } from './orm-review-service'
import { resolveOrmReviewDeps, type OrmReviewDepsInput } from './orm-review-service-deps'
import type { OrmReviewRegisteredTarget } from './orm-review-targets'
import { PRISMA_COMMANDS, prismaCliProgram, tailOutput } from './prisma-commands'

export class OrmReviewExecution {
  private readonly deps
  /** Serializes execution per resolved target identity. */
  private readonly targetChains = new Map<string, Promise<unknown>>()

  constructor(
    deps: OrmReviewDepsInput,
    private readonly service: OrmReviewService
  ) {
    this.deps = resolveOrmReviewDeps(deps)
  }

  async run(args: {
    worktreeId: string
    worktreeRoot: string
    configId: string
    targetId: string
    command: OrmReviewCommandKind
    prepared: OrmReviewRunPreparation
  }): Promise<OrmReviewRunResult> {
    const configs = await this.service.discoverConfigs(args.worktreeRoot)
    const config = configs.find((c) => c.configId === args.configId) ?? null
    if (!config) {
      return { records: [], rejected: 'unknown-config' }
    }
    const target = this.deps.targets.resolve(args.worktreeId, args.targetId)
    if (!target) {
      return { records: [], rejected: 'unknown-target' }
    }

    // Revalidation happens inside the chain so a queued run re-checks the
    // state it actually runs against, not the state at queue time.
    const key = target.identityHash
    const previous = this.targetChains.get(key) ?? Promise.resolve()
    const run = previous.then(() => this.executeSerialized(args, config, target))
    this.targetChains.set(
      key,
      run.catch(() => {})
    )
    return run
  }

  private async executeSerialized(
    args: {
      worktreeId: string
      worktreeRoot: string
      command: OrmReviewCommandKind
      prepared: OrmReviewRunPreparation
    },
    config: OrmReviewConfigDescriptor,
    target: OrmReviewRegisteredTarget
  ): Promise<OrmReviewRunResult> {
    const { inputDigest } = await this.service.currentInputs(args.worktreeRoot, config)
    if (
      inputDigest !== args.prepared.inputDigest ||
      target.identityHash !== args.prepared.targetIdentityHash
    ) {
      return { records: [], rejected: 'stale-preparation' }
    }

    const spec = PRISMA_COMMANDS[args.command]
    const [gitRevision, dirtyDigest] = await Promise.all([
      this.deps.headRevision(args.worktreeRoot),
      this.deps.dirtyDigest(args.worktreeRoot)
    ])
    const startedAt = this.deps.now()
    const base = {
      worktreeId: args.worktreeId,
      configId: config.configId,
      gitRevision,
      dirtyDigest,
      inputDigest,
      toolVersion: null,
      targetId: target.targetId,
      targetLabel: `${target.label} (${target.redactedUrl})`,
      targetIdentityHash: target.identityHash,
      startedAt
    }

    const pending = await this.deps.store.append(args.worktreeId, {
      ...base,
      kind: spec.kind,
      state: 'running',
      commandLabel: spec.label,
      endedAt: null,
      exitCode: null,
      outputTail: '',
      outputTruncated: false
    })

    let result: ProcessResult
    try {
      result = await this.deps.runCommand({
        program: prismaCliProgram(args.worktreeRoot, config.projectDir),
        args: [...spec.args, '--schema', config.schemaPath],
        cwd: join(args.worktreeRoot, config.projectDir),
        env: { ...process.env, DATABASE_URL: target.url }
      })
    } catch (error) {
      const tail = tailOutput(String(error))
      // A spawn failure (e.g. the project has no prisma CLI installed) never
      // ran against the database — a failed launch, not an unknown outcome.
      const spawnFailed = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      const record = (await this.deps.store.update(args.worktreeId, pending.evidenceId, {
        state: spawnFailed ? 'failed' : 'unknown',
        endedAt: this.deps.now(),
        outputTail: redactSecretsFromText(tail.tail, [target.url]),
        outputTruncated: tail.truncated
      }))!
      return { records: [record] }
    }

    const combined = redactSecretsFromText(`${result.stdout}\n${result.stderr}`.trim(), [
      target.url
    ])
    const tail = tailOutput(combined)
    const record = (await this.deps.store.update(args.worktreeId, pending.evidenceId, {
      state:
        result.code === 0
          ? 'passed'
          : result.timedOut || result.code === null
            ? 'unknown'
            : 'failed',
      endedAt: this.deps.now(),
      exitCode: result.code,
      outputTail: tail.tail,
      outputTruncated: tail.truncated || result.outputTruncated === true
    }))!

    const records = [record]

    // A successful apply is followed by an independent status check so
    // "migration applied" and "schema checked" stay separate claims.
    if (record.state === 'passed' && spec.kind === 'migration-applied') {
      const check = await this.runStatusCheck(args, config, target, {
        gitRevision,
        dirtyDigest,
        inputDigest
      })
      records.push(check)
    }
    return { records }
  }

  private async runStatusCheck(
    args: { worktreeId: string; worktreeRoot: string },
    config: OrmReviewConfigDescriptor,
    target: OrmReviewRegisteredTarget,
    inputs: { gitRevision: string | null; dirtyDigest: string | null; inputDigest: string }
  ): Promise<OrmReviewEvidenceRecord> {
    const startedAt = this.deps.now()
    const result = await this.deps.runCommand({
      program: prismaCliProgram(args.worktreeRoot, config.projectDir),
      args: [...PRISMA_COMMANDS['migrate-status'].args, '--schema', config.schemaPath],
      cwd: join(args.worktreeRoot, config.projectDir),
      env: { ...process.env, DATABASE_URL: target.url }
    })
    const tail = tailOutput(
      redactSecretsFromText(`${result.stdout}\n${result.stderr}`.trim(), [target.url])
    )
    return this.deps.store.append(args.worktreeId, {
      worktreeId: args.worktreeId,
      configId: config.configId,
      kind: 'schema-checked',
      state: result.code === 0 ? 'passed' : 'failed',
      gitRevision: inputs.gitRevision,
      dirtyDigest: inputs.dirtyDigest,
      inputDigest: inputs.inputDigest,
      toolVersion: null,
      targetId: target.targetId,
      targetLabel: `${target.label} (${target.redactedUrl})`,
      targetIdentityHash: target.identityHash,
      commandLabel: PRISMA_COMMANDS['migrate-status'].label,
      startedAt,
      endedAt: this.deps.now(),
      exitCode: result.code,
      outputTail: tail.tail,
      outputTruncated: tail.truncated || result.outputTruncated === true
    })
  }

  /**
   * Records left `running` by a crash or kill are reconciled by re-reading the
   * live migration history in a separate check — never a blind retry, never a
   * fabricated success.
   */
  async reconcileInterrupted(args: {
    worktreeId: string
    worktreeRoot: string
    configId: string
    targetId: string
  }): Promise<OrmReviewEvidenceRecord[]> {
    const records = await this.deps.store.list(args.worktreeId)
    const interrupted = records.filter(
      (r) => r.state === 'running' || r.state === 'reconciling'
    )
    if (interrupted.length === 0) {
      return []
    }
    for (const record of interrupted) {
      await this.deps.store.update(args.worktreeId, record.evidenceId, { state: 'reconciling' })
    }
    const configs = await this.service.discoverConfigs(args.worktreeRoot)
    const config = configs.find((c) => c.configId === args.configId) ?? null
    const target = this.deps.targets.resolve(args.worktreeId, args.targetId)
    if (!config || !target) {
      const settled: OrmReviewEvidenceRecord[] = []
      for (const record of interrupted) {
        settled.push(
          (await this.deps.store.update(args.worktreeId, record.evidenceId, {
            state: 'unknown',
            outputTail: 'reconciliation unavailable: target or config unknown'
          }))!
        )
      }
      return settled
    }
    const { inputDigest } = await this.service.currentInputs(args.worktreeRoot, config)
    const check = await this.runStatusCheck(args, config, target, {
      gitRevision: await this.deps.headRevision(args.worktreeRoot),
      dirtyDigest: await this.deps.dirtyDigest(args.worktreeRoot),
      inputDigest
    })
    const settled: OrmReviewEvidenceRecord[] = []
    for (const record of interrupted) {
      settled.push(
        (await this.deps.store.update(args.worktreeId, record.evidenceId, {
          state: 'unknown',
          endedAt: record.endedAt ?? this.deps.now(),
          outputTail:
            'interrupted before outcome was known; migration history was re-read in a separate check'
        }))!
      )
    }
    return [...settled, check]
  }
}
