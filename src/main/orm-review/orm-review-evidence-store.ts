/**
 * Per-worktree ORM review evidence persistence. Whole-file atomic writes via
 * the durable-file-write helpers; a crash leaves the previous committed file,
 * never a torn record. The directory is injected so tests use a tmpdir.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ORM_REVIEW_EVIDENCE_SCHEMA_VERSION,
  type OrmReviewEvidenceRecord
} from '../../shared/orm-review'
import { renameDurable, writeTempFileDurable } from '../durable-file-write'

const STORE_FILE_PREFIX = 'orm-review-'

function storeFileName(worktreeId: string): string {
  const key = createHash('sha256').update(worktreeId).digest('hex').slice(0, 24)
  return `${STORE_FILE_PREFIX}${key}.json`
}

type StoreFile = {
  schemaVersion: number
  records: OrmReviewEvidenceRecord[]
}

function isRecord(value: unknown): value is OrmReviewEvidenceRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.evidenceId === 'string' &&
    typeof record.worktreeId === 'string' &&
    typeof record.inputDigest === 'string' &&
    typeof record.state === 'string' &&
    typeof record.startedAt === 'number'
  )
}

export class OrmReviewEvidenceStore {
  constructor(private readonly directory: string) {}

  async list(worktreeId: string): Promise<OrmReviewEvidenceRecord[]> {
    let raw: string
    try {
      raw = await readFile(join(this.directory, storeFileName(worktreeId)), 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      if (parsed.schemaVersion !== ORM_REVIEW_EVIDENCE_SCHEMA_VERSION) {
        return []
      }
      return Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : []
    } catch {
      return []
    }
  }

  async append(
    worktreeId: string,
    record: Omit<OrmReviewEvidenceRecord, 'evidenceId'>
  ): Promise<OrmReviewEvidenceRecord> {
    const withId: OrmReviewEvidenceRecord = { ...record, evidenceId: randomUUID() }
    const records = [...(await this.list(worktreeId)), withId]
    await this.persist(worktreeId, records)
    return withId
  }

  async update(
    worktreeId: string,
    evidenceId: string,
    patch: Partial<OrmReviewEvidenceRecord>
  ): Promise<OrmReviewEvidenceRecord | null> {
    const records = await this.list(worktreeId)
    const index = records.findIndex((r) => r.evidenceId === evidenceId)
    if (index === -1) {
      return null
    }
    records[index] = { ...records[index], ...patch, evidenceId }
    await this.persist(worktreeId, records)
    return records[index]
  }

  private async persist(
    worktreeId: string,
    records: OrmReviewEvidenceRecord[]
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const file: StoreFile = { schemaVersion: ORM_REVIEW_EVIDENCE_SCHEMA_VERSION, records }
    const finalPath = join(this.directory, storeFileName(worktreeId))
    const tmpPath = `${finalPath}.tmp`
    await writeTempFileDurable(tmpPath, JSON.stringify(file))
    await renameDurable(tmpPath, finalPath)
  }
}
