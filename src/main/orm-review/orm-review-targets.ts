/**
 * Runtime-side registry of explicitly selected development database targets.
 * URLs live here only — everything downstream (evidence, wire, agent packets)
 * carries the redacted descriptor. Memory-only by design: this slice does not
 * persist credentials at rest, so a restart honestly reports targets as gone.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { OrmReviewTargetDescriptor } from '../../shared/orm-review'
import { redactConnectionUrl } from './orm-review-redaction'

export type OrmReviewRegisteredTarget = OrmReviewTargetDescriptor & {
  /** Never leaves this registry. */
  url: string
}

export function targetIdentityHash(url: string): string {
  let normalized = url.trim()
  try {
    const parsed = new URL(normalized)
    parsed.username = ''
    parsed.password = ''
    normalized = parsed.toString()
  } catch {
    // Non-URL targets (e.g. SQLite file paths) hash as-is.
  }
  return createHash('sha256').update(normalized).digest('hex')
}

export class OrmReviewTargetRegistry {
  private readonly targets = new Map<string, OrmReviewRegisteredTarget>()

  register(worktreeId: string, label: string, url: string): OrmReviewTargetDescriptor {
    const target: OrmReviewRegisteredTarget = {
      targetId: randomUUID(),
      label,
      redactedUrl: redactConnectionUrl(url),
      identityHash: targetIdentityHash(url),
      url
    }
    this.targets.set(this.key(worktreeId, target.targetId), target)
    return this.descriptor(target)
  }

  resolve(worktreeId: string, targetId: string): OrmReviewRegisteredTarget | null {
    return this.targets.get(this.key(worktreeId, targetId)) ?? null
  }

  list(worktreeId: string): OrmReviewTargetDescriptor[] {
    return [...this.targets.entries()]
      .filter(([key]) => key.startsWith(`${worktreeId}\0`))
      .map(([, target]) => this.descriptor(target))
  }

  private descriptor(target: OrmReviewRegisteredTarget): OrmReviewTargetDescriptor {
    const { url: _url, ...descriptor } = target
    return descriptor
  }

  private key(worktreeId: string, targetId: string): string {
    return `${worktreeId}\0${targetId}`
  }
}
