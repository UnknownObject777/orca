import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/process-spec'
import { OrmReviewEvidenceStore } from './orm-review-evidence-store'
import { OrmReviewExecution } from './orm-review-execution'
import { OrmReviewService } from './orm-review-service'
import type { OrmReviewCommandRunner } from './prisma-commands'
import { OrmReviewTargetRegistry } from './orm-review-targets'

let root: string
let storeDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orm-review-svc-'))
  storeDir = await mkdtemp(join(tmpdir(), 'orm-review-store-'))
  await mkdir(join(root, 'prisma', 'migrations', '20240101000000_init'), { recursive: true })
  await mkdir(join(root, 'prisma', 'migrations', '20240201000000_add_bookmarks'), {
    recursive: true
  })
  await writeFile(join(root, 'prisma', 'schema.prisma'), 'model User {\n  id Int @id\n}\n')
  await writeFile(
    join(root, 'prisma', 'migrations', '20240101000000_init', 'migration.sql'),
    'CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);'
  )
  await writeFile(
    join(root, 'prisma', 'migrations', '20240201000000_add_bookmarks', 'migration.sql'),
    'CREATE TABLE "Bookmark" ("id" INTEGER PRIMARY KEY);'
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(storeDir, { recursive: true, force: true })
})

function okResult(stdout: string): ProcessResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

function makeService(runCommand: OrmReviewCommandRunner) {
  const store = new OrmReviewEvidenceStore(storeDir)
  const targets = new OrmReviewTargetRegistry()
  let clock = 1_000
  const deps = {
    store,
    targets,
    runCommand,
    runtimeId: 'runtime-test',
    now: () => ++clock,
    headRevision: async () => 'abc123',
    dirtyDigest: async () => 'dirty-1'
  }
  const service = new OrmReviewService(deps)
  const execution = new OrmReviewExecution(deps, service)
  return { service, execution, store, targets }
}

const URL = 'postgresql://alice:hunter2@db.local:5432/bookmarks'

function registerTarget(targets: OrmReviewTargetRegistry) {
  return targets.register('wt-1', 'bookmarks-dev', URL)
}

async function discoverConfigId(service: OrmReviewService): Promise<string> {
  const configs = await service.discoverConfigs(root)
  expect(configs).toHaveLength(1)
  return configs[0].configId
}

describe('OrmReviewService.getStatus', () => {
  it('reports unknown views when no ORM config exists', async () => {
    const { service } = makeService(async () => okResult(''))
    const empty = await mkdtemp(join(tmpdir(), 'orm-review-empty-'))
    const status = await service.getStatus({ worktreeId: 'wt-1', worktreeRoot: empty })
    expect(status.declaredModel.state).toBe('unknown')
    expect(status.observedDatabase.state).toBe('unknown')
    await rm(empty, { recursive: true, force: true })
  })

  it('assembles declared model and migration history without a target', async () => {
    const { service } = makeService(async () => okResult(''))
    const status = await service.getStatus({ worktreeId: 'wt-1', worktreeRoot: root })
    expect(status.declaredModel).toMatchObject({ state: 'ok', modelNames: ['User'] })
    expect(status.migrationHistory.state).toBe('ok')
    expect(status.observedDatabase).toMatchObject({ state: 'unknown', reason: 'no-target-selected' })
    expect(status.capabilities.introspection).toBe('unsupported')
  })
})

describe('OrmReviewService.run', () => {
  it('records a passing run with redacted output and separate post-check', async () => {
    const commands: string[][] = []
    const { service, execution, targets } = makeService(async ({ args }) => {
      commands.push([...args])
      if (args.includes('status')) {
        return okResult('The following migration has not yet been applied:\n20240201000000_add_bookmarks')
      }
      return okResult(`applied against ${URL}`)
    })
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)

    const prepared = await service.prepareRun({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })
    expect(prepared).not.toHaveProperty('rejected')

    const result = await execution.run({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId,
      command: 'migrate-dev',
      prepared: prepared as { inputDigest: string; targetIdentityHash: string }
    })

    expect(result.rejected).toBeUndefined()
    expect(result.records).toHaveLength(2)
    const [applied, checked] = result.records
    expect(applied.kind).toBe('migration-applied')
    expect(applied.state).toBe('passed')
    expect(checked.kind).toBe('schema-checked')
    expect(applied.outputTail).not.toContain('hunter2')
    expect(applied.outputTail).not.toContain(URL)
    expect(applied.targetLabel).not.toContain('hunter2')
    // Post-check ran the real status command after the apply.
    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain('status')
  })

  it('keeps apply-passed but check-failed as separate outcomes', async () => {
    const { service, execution, targets } = makeService(async ({ args }) =>
      args.includes('status')
        ? { code: 1, signal: null, stdout: '', stderr: 'status failed', timedOut: false }
        : okResult('applied')
    )
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)
    const prepared = (await service.prepareRun({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })) as { inputDigest: string; targetIdentityHash: string }

    const result = await execution.run({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId,
      command: 'migrate-deploy',
      prepared
    })
    expect(result.records[0]).toMatchObject({ kind: 'migration-applied', state: 'passed' })
    expect(result.records[1]).toMatchObject({ kind: 'schema-checked', state: 'failed' })
  })

  it('rejects a stale preparation when files changed after prepare', async () => {
    const { service, execution, targets } = makeService(async () => okResult(''))
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)
    const prepared = (await service.prepareRun({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })) as { inputDigest: string; targetIdentityHash: string }

    await writeFile(
      join(root, 'prisma', 'schema.prisma'),
      'model User {\n  id Int @id\n  email String\n}\n'
    )

    const result = await execution.run({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId,
      command: 'migrate-dev',
      prepared
    })
    expect(result.rejected).toBe('stale-preparation')
    expect(result.records).toHaveLength(0)
  })

  it('serializes two runs against the same target', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const { service, execution, targets } = makeService(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 20))
      concurrent--
      return okResult('')
    })
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)
    const prepared = (await service.prepareRun({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })) as { inputDigest: string; targetIdentityHash: string }

    await Promise.all([
      execution.run({
        worktreeId: 'wt-1',
        worktreeRoot: root,
        configId,
        targetId: target.targetId,
        command: 'validate',
        prepared
      }),
      execution.run({
        worktreeId: 'wt-1',
        worktreeRoot: root,
        configId,
        targetId: target.targetId,
        command: 'validate',
        prepared
      })
    ])
    expect(maxConcurrent).toBe(1)
  })

  it('marks evidence stale after an uncommitted model edit at the same HEAD', async () => {
    const { service, execution, targets } = makeService(async () => okResult('Database is up to date'))
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)
    const prepared = (await service.prepareRun({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })) as { inputDigest: string; targetIdentityHash: string }
    await execution.run({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId,
      command: 'validate',
      prepared
    })

    let status = await service.getStatus({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })
    expect(status.evidence.map((e) => e.effectiveState)).toContain('passed')

    await writeFile(join(root, 'prisma', 'schema.prisma'), 'model User {\n  id Int @id\n}\n\nmodel Post {\n  id Int @id\n}\n')

    status = await service.getStatus({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })
    // HEAD unchanged (fake returns abc123) but the dirty input changed.
    expect(status.evidence.map((e) => e.effectiveState)).toContain('stale')
  })
})

describe('OrmReviewService.reconcileInterrupted', () => {
  it('settles an interrupted run as unknown and re-reads history separately', async () => {
    const { service, execution, store, targets } = makeService(async () => okResult('Database is up to date'))
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)

    // Simulate a crash: a record left in `running`.
    await store.append('wt-1', {
      worktreeId: 'wt-1',
      configId,
      kind: 'migration-applied',
      state: 'running',
      gitRevision: 'abc123',
      dirtyDigest: 'dirty-1',
      inputDigest: 'whatever',
      toolVersion: null,
      targetId: target.targetId,
      targetLabel: target.label,
      targetIdentityHash: target.identityHash,
      commandLabel: 'prisma migrate dev',
      startedAt: 1,
      endedAt: null,
      exitCode: null,
      outputTail: '',
      outputTruncated: false
    })

    const settled = await execution.reconcileInterrupted({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })
    const interrupted = settled.find((r) => r.kind === 'migration-applied')!
    expect(interrupted.state).toBe('unknown')
    const historyCheck = settled.find((r) => r.kind === 'schema-checked')!
    expect(historyCheck.state).toBe('passed')
  })
})

describe('OrmReviewService restart semantics', () => {
  it('shows a running record from a previous process as unknown, not running', async () => {
    const { service, store, targets } = makeService(async () => okResult(''))
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)
    await store.append('wt-1', {
      worktreeId: 'wt-1',
      configId,
      kind: 'migration-applied',
      state: 'running',
      gitRevision: 'abc123',
      dirtyDigest: 'dirty-1',
      inputDigest: 'i1',
      toolVersion: null,
      targetId: target.targetId,
      targetLabel: target.label,
      targetIdentityHash: target.identityHash,
      commandLabel: 'prisma migrate dev',
      startedAt: 1, // long before this service was constructed
      endedAt: null,
      exitCode: null,
      outputTail: '',
      outputTruncated: false
    })
    const status = await service.getStatus({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })
    expect(status.evidence[0].effectiveState).toBe('unknown')
  })

  it('records a spawn failure as failed, not unknown', async () => {
    const enoent = Object.assign(new Error('spawn prisma.cmd ENOENT'), { code: 'ENOENT' })
    const { service, execution, targets } = makeService(async () => {
      throw enoent
    })
    const target = registerTarget(targets)
    const configId = await discoverConfigId(service)
    const prepared = (await service.prepareRun({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId
    })) as { inputDigest: string; targetIdentityHash: string }
    const result = await execution.run({
      worktreeId: 'wt-1',
      worktreeRoot: root,
      configId,
      targetId: target.targetId,
      command: 'validate',
      prepared
    })
    expect(result.records[0].state).toBe('failed')
  })
})
