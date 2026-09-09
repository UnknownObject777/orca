import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrmReviewEvidenceRecord } from '../../shared/orm-review'
import { OrmReviewEvidenceStore } from './orm-review-evidence-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orm-review-store-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const RECORD: Omit<OrmReviewEvidenceRecord, 'evidenceId'> = {
  worktreeId: 'wt-1',
  configId: 'cfg-1',
  kind: 'schema-checked',
  state: 'passed',
  gitRevision: 'abc',
  dirtyDigest: 'd1',
  inputDigest: 'i1',
  toolVersion: null,
  targetId: 't-1',
  targetLabel: 'dev (****)',
  targetIdentityHash: 'h1',
  commandLabel: 'prisma validate',
  startedAt: 1,
  endedAt: 2,
  exitCode: 0,
  outputTail: 'ok',
  outputTruncated: false
}

describe('OrmReviewEvidenceStore', () => {
  it('appends and lists records per worktree', async () => {
    const store = new OrmReviewEvidenceStore(dir)
    const a = await store.append('wt-1', RECORD)
    await store.append('wt-2', { ...RECORD, worktreeId: 'wt-2' })
    expect(await store.list('wt-1')).toEqual([a])
    expect((await store.list('wt-2'))[0].worktreeId).toBe('wt-2')
  })

  it('updates a record without disturbing others', async () => {
    const store = new OrmReviewEvidenceStore(dir)
    const a = await store.append('wt-1', RECORD)
    const b = await store.append('wt-1', { ...RECORD, commandLabel: 'prisma migrate dev' })
    const updated = await store.update('wt-1', a.evidenceId, { state: 'failed', exitCode: 1 })
    expect(updated?.state).toBe('failed')
    const all = await store.list('wt-1')
    expect(all).toHaveLength(2)
    expect(all.find((r) => r.evidenceId === b.evidenceId)?.state).toBe('passed')
  })

  it('treats a corrupt file as no history rather than crashing', async () => {
    const store = new OrmReviewEvidenceStore(dir)
    const record = await store.append('wt-1', RECORD)
    const files = await readdir(dir)
    await writeFile(join(dir, files[0]), 'not json{')
    expect(await store.list('wt-1')).toEqual([])
    // And the store recovers writable.
    await store.append('wt-1', RECORD)
    expect((await store.list('wt-1')).map((r) => r.evidenceId)).not.toContain(record.evidenceId)
  })

  it('returns empty for unknown worktrees', async () => {
    const store = new OrmReviewEvidenceStore(dir)
    expect(await store.list('nobody')).toEqual([])
  })
})
