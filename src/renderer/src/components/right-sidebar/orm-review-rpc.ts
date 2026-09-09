/**
 * Renderer-side RPC wrappers for the ORM review surface. Calls are routed to
 * the runtime that owns the worktree; secrets only ever travel client → owning
 * runtime on registration, never the other way.
 */
import type {
  OrmReviewCommandKind,
  OrmReviewContextPacket,
  OrmReviewRunPreparation,
  OrmReviewRunResult,
  OrmReviewStatusResult,
  OrmReviewTargetDescriptor
} from '../../../../shared/orm-review'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'

function targetForWorktree(worktreeId: string) {
  return getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktreeId)
  )
}

export function fetchOrmReviewStatus(
  worktreeId: string,
  selection: { configId?: string; targetId?: string }
): Promise<OrmReviewStatusResult> {
  return callRuntimeRpc(targetForWorktree(worktreeId), 'ormReview.status', {
    worktree: worktreeId,
    ...selection
  })
}

export function registerOrmReviewTarget(
  worktreeId: string,
  label: string,
  url: string
): Promise<OrmReviewTargetDescriptor> {
  return callRuntimeRpc(targetForWorktree(worktreeId), 'ormReview.registerTarget', {
    worktree: worktreeId,
    label,
    url
  })
}

export async function runOrmReviewCommand(args: {
  worktreeId: string
  configId: string
  targetId: string
  command: OrmReviewCommandKind
}): Promise<OrmReviewRunResult> {
  const target = targetForWorktree(args.worktreeId)
  const prepared = await callRuntimeRpc<OrmReviewRunPreparation>(target, 'ormReview.prepare', {
    worktree: args.worktreeId,
    configId: args.configId,
    targetId: args.targetId
  })
  return callRuntimeRpc(
    target,
    'ormReview.run',
    {
      worktree: args.worktreeId,
      configId: args.configId,
      targetId: args.targetId,
      command: args.command,
      prepared
    },
    { timeoutMs: 10 * 60_000 }
  )
}

export function buildOrmReviewPacket(args: {
  worktreeId: string
  evidenceId: string
  userRequest: string
}): Promise<OrmReviewContextPacket | null> {
  return callRuntimeRpc(targetForWorktree(args.worktreeId), 'ormReview.buildPacket', {
    worktree: args.worktreeId,
    evidenceId: args.evidenceId,
    userRequest: args.userRequest
  })
}
