import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'

const Worktree = z.object({
  worktree: z.string().min(1).max(4096)
})

const ConfigAndTarget = Worktree.extend({
  configId: z.string().min(1).max(256),
  targetId: z.string().min(1).max(256)
})

const Preparation = z.object({
  inputDigest: z.string().min(1).max(256),
  targetIdentityHash: z.string().min(1).max(256)
})

export const ORM_REVIEW_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'ormReview.status',
    params: Worktree.extend({
      configId: z.string().min(1).max(256).optional(),
      targetId: z.string().min(1).max(256).optional()
    }),
    handler: (params, { runtime }) => runtime.ormReviewStatus(params)
  }),
  defineMethod({
    name: 'ormReview.registerTarget',
    params: Worktree.extend({
      label: z.string().min(1).max(256),
      url: z.string().min(1).max(4096)
    }),
    handler: (params, { runtime }) => runtime.ormReviewRegisterTarget(params)
  }),
  defineMethod({
    name: 'ormReview.prepare',
    params: ConfigAndTarget,
    handler: (params, { runtime }) => runtime.ormReviewPrepare(params)
  }),
  defineMethod({
    name: 'ormReview.run',
    params: ConfigAndTarget.extend({
      command: z.enum(['migrate-status', 'migrate-dev', 'migrate-deploy', 'validate']),
      prepared: Preparation
    }),
    handler: (params, { runtime }) => runtime.ormReviewRun(params)
  }),
  defineMethod({
    name: 'ormReview.reconcile',
    params: ConfigAndTarget,
    handler: (params, { runtime }) => runtime.ormReviewReconcile(params)
  }),
  defineMethod({
    name: 'ormReview.buildPacket',
    params: Worktree.extend({
      evidenceId: z.string().min(1).max(256),
      userRequest: z.string().min(1).max(8192)
    }),
    handler: (params, { runtime }) => runtime.ormReviewBuildPacket(params)
  })
]
