/**
 * Runtime surface for the worktree ORM review feature (spec: #19711/#19714).
 * The service, evidence store, and target registry live on the owning runtime;
 * clients only ever see redacted descriptors and evidence views.
 */
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { runProcess } from '../../shared/child-process/run-process'
import type {
  OrmReviewCommandKind,
  OrmReviewContextPacket,
  OrmReviewEvidenceRecord,
  OrmReviewRunPreparation,
  OrmReviewRunResult,
  OrmReviewStatusResult,
  OrmReviewTargetDescriptor
} from '../../shared/orm-review'
import { OrmReviewEvidenceStore } from '../orm-review/orm-review-evidence-store'
import { OrmReviewExecution } from '../orm-review/orm-review-execution'
import { buildEvidenceContextPacket } from '../orm-review/orm-review-packet'
import { OrmReviewService } from '../orm-review/orm-review-service'
import { OrmReviewTargetRegistry } from '../orm-review/orm-review-targets'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

const ORM_REVIEW_COMMAND_TIMEOUT_MS = 10 * 60_000

export class OrcaRuntimeWithOrmReview extends OrcaRuntimeWithResolveWaiter {
  private ormReview: { service: OrmReviewService; execution: OrmReviewExecution } | null = null
  private readonly ormReviewTargets = new OrmReviewTargetRegistry()

  protected getOrmReview(): {
    service: OrmReviewService
    execution: OrmReviewExecution
  } {
    if (!this.ormReview) {
      const deps = {
        store: new OrmReviewEvidenceStore(
          join(getAppEnvironment().getPath('userData'), 'orm-review')
        ),
        targets: this.ormReviewTargets,
        runtimeId: this.runtimeId,
        runCommand: ({
          program,
          args,
          cwd,
          env
        }: {
          program: string
          args: readonly string[]
          cwd: string
          env: NodeJS.ProcessEnv
        }) =>
          runProcess({
            program,
            args,
            cwd,
            env,
            timeoutMs: ORM_REVIEW_COMMAND_TIMEOUT_MS,
            maxOutputBytes: 1024 * 1024
          })
      }
      const service = new OrmReviewService(deps)
      this.ormReview = { service, execution: new OrmReviewExecution(deps, service) }
    }
    return this.ormReview
  }

  /** Managed worktrees resolve through the registry; folder workspaces by id. */
  private async resolveOrmReviewWorktree(
    selector: string
  ): Promise<{ worktreeId: string; worktreeRoot: string }> {
    try {
      const worktree = await this.showManagedWorktree(selector)
      return { worktreeId: worktree.id, worktreeRoot: worktree.path }
    } catch {
      const folder = (this.store?.getFolderWorkspaces?.() ?? []).find((w) => w.id === selector)
      if (folder) {
        return { worktreeId: folder.id, worktreeRoot: folder.folderPath }
      }
      throw new Error(`Unknown worktree: ${selector}`)
    }
  }

  async ormReviewStatus(params: {
    worktree: string
    configId?: string
    targetId?: string
  }): Promise<OrmReviewStatusResult> {
    const { worktreeId, worktreeRoot } = await this.resolveOrmReviewWorktree(params.worktree)
    return this.getOrmReview().service.getStatus({
      worktreeId,
      worktreeRoot,
      configId: params.configId ?? null,
      targetId: params.targetId ?? null
    })
  }

  async ormReviewRegisterTarget(params: {
    worktree: string
    label: string
    url: string
  }): Promise<OrmReviewTargetDescriptor> {
    // Resolve first so targets key on the same worktree id the status path uses.
    const { worktreeId } = await this.resolveOrmReviewWorktree(params.worktree)
    return this.ormReviewTargets.register(worktreeId, params.label, params.url)
  }

  async ormReviewPrepare(params: {
    worktree: string
    configId: string
    targetId: string
  }): Promise<OrmReviewRunPreparation | { rejected: 'unknown-target' | 'unknown-config' }> {
    const { worktreeId, worktreeRoot } = await this.resolveOrmReviewWorktree(params.worktree)
    return this.getOrmReview().service.prepareRun({
      worktreeId,
      worktreeRoot,
      configId: params.configId,
      targetId: params.targetId
    })
  }

  async ormReviewRun(params: {
    worktree: string
    configId: string
    targetId: string
    command: OrmReviewCommandKind
    prepared: OrmReviewRunPreparation
  }): Promise<OrmReviewRunResult> {
    const { worktreeId, worktreeRoot } = await this.resolveOrmReviewWorktree(params.worktree)
    return this.getOrmReview().execution.run({
      worktreeId,
      worktreeRoot,
      configId: params.configId,
      targetId: params.targetId,
      command: params.command,
      prepared: params.prepared
    })
  }

  async ormReviewReconcile(params: {
    worktree: string
    configId: string
    targetId: string
  }): Promise<OrmReviewEvidenceRecord[]> {
    const { worktreeId, worktreeRoot } = await this.resolveOrmReviewWorktree(params.worktree)
    return this.getOrmReview().execution.reconcileInterrupted({
      worktreeId,
      worktreeRoot,
      configId: params.configId,
      targetId: params.targetId
    })
  }

  async ormReviewBuildPacket(params: {
    worktree: string
    evidenceId: string
    userRequest: string
  }): Promise<OrmReviewContextPacket | null> {
    const { worktreeId } = await this.resolveOrmReviewWorktree(params.worktree)
    const records = await this.getOrmReview().service.listEvidence(worktreeId)
    const record = records.find((r) => r.evidenceId === params.evidenceId)
    if (!record) {
      return null
    }
    const target = record.targetId
      ? this.ormReviewTargets.resolve(worktreeId, record.targetId)
      : null
    return buildEvidenceContextPacket({
      record,
      runtimeId: this.runtimeId,
      userRequest: params.userRequest,
      secrets: target ? [target.url] : []
    })
  }
}
