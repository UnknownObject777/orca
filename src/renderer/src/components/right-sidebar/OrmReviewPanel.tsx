import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type {
  OrmReviewCommandKind,
  OrmReviewContextPacket,
  OrmReviewStatusResult
} from '../../../../shared/orm-review'
import {
  buildOrmReviewPacket,
  fetchOrmReviewStatus,
  registerOrmReviewTarget,
  runOrmReviewCommand
} from './orm-review-rpc'
import {
  OrmReviewEvidenceSection,
  OrmReviewPacketPreview,
  StateBadge
} from './orm-review-panel-sections'
import { translate } from '@/i18n/i18n'

const RUN_COMMANDS = [
  ['validate', 'Validate'],
  ['migrate-status', 'Check status'],
  ['migrate-dev', 'Migrate dev'],
  ['migrate-deploy', 'Migrate deploy']
] as const

export default function OrmReviewPanel(): React.JSX.Element {
  const worktreeId = useAppStore((s) => s.activeWorktreeId)
  const [status, setStatus] = useState<OrmReviewStatusResult | null>(null)
  const [configId, setConfigId] = useState<string | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [targetLabel, setTargetLabel] = useState('')
  const [targetUrl, setTargetUrl] = useState('')
  const [running, setRunning] = useState<OrmReviewCommandKind | null>(null)
  const [question, setQuestion] = useState('')
  const [packet, setPacket] = useState<OrmReviewContextPacket | null>(null)

  const refresh = useCallback(async () => {
    if (!worktreeId) {
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await fetchOrmReviewStatus(worktreeId, {
        configId: configId ?? undefined,
        targetId: targetId ?? undefined
      })
      setStatus(next)
      if (!configId && next.selectedConfigId) {
        setConfigId(next.selectedConfigId)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [worktreeId, configId, targetId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selectedTarget = useMemo(
    () => status?.targets.find((t) => t.targetId === targetId) ?? null,
    [status, targetId]
  )

  const addTarget = useCallback(async () => {
    if (!worktreeId || !targetLabel.trim() || !targetUrl.trim()) {
      return
    }
    try {
      const target = await registerOrmReviewTarget(worktreeId, targetLabel.trim(), targetUrl.trim())
      setTargetId(target.targetId)
      setTargetLabel('')
      setTargetUrl('')
      await refresh()
    } catch (err) {
      toast.error(String(err))
    }
  }, [worktreeId, targetLabel, targetUrl, refresh])

  const runCommand = useCallback(
    async (command: OrmReviewCommandKind) => {
      if (!worktreeId || !configId || !targetId) {
        return
      }
      setRunning(command)
      try {
        const result = await runOrmReviewCommand({ worktreeId, configId, targetId, command })
        if (result.rejected === 'stale-preparation') {
          toast.warning(
            translate(
              'auto.components.right.sidebar.ormReview.stalePreparation',
              'Inputs changed before execution — review again and retry.'
            )
          )
        }
        await refresh()
      } catch (err) {
        toast.error(String(err))
      } finally {
        setRunning(null)
      }
    },
    [worktreeId, configId, targetId, refresh]
  )

  const preparePacket = useCallback(
    async (evidenceId: string) => {
      if (!worktreeId || !question.trim()) {
        return
      }
      const built = await buildOrmReviewPacket({
        worktreeId,
        evidenceId,
        userRequest: question.trim()
      })
      if (!built) {
        toast.error(
          translate('auto.components.right.sidebar.ormReview.noEvidence', 'Evidence not found.')
        )
        return
      }
      setPacket(built)
    },
    [worktreeId, question]
  )

  if (!worktreeId) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.ormReview.noWorktree',
          'Select a worktree to review its data changes.'
        )}
      </div>
    )
  }

  return (
    <div className="worktree-sidebar-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">
          {translate('auto.components.right.sidebar.ormReview.title', 'Data')}
        </span>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {translate('auto.components.right.sidebar.ormReview.refresh', 'Refresh')}
        </button>
      </div>

      {error && <div className="text-rose-500">{error}</div>}

      {status && status.configs.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {translate('auto.components.right.sidebar.ormReview.config', 'ORM config')}
          </span>
          <select
            className="rounded border border-border bg-background px-1.5 py-1"
            value={configId ?? ''}
            onChange={(e) => setConfigId(e.target.value || null)}
          >
            {status.configs.map((config) => (
              <option key={config.configId} value={config.configId}>
                {config.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      {status && status.configs.length === 0 && (
        <div className="text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.ormReview.noConfig',
            'No supported ORM config (Prisma) detected in this worktree.'
          )}
        </div>
      )}

      {status && status.configs.length > 0 && (
        <>
          <section className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {translate('auto.components.right.sidebar.ormReview.target', 'Database target')}
            </span>
            {status.targets.length > 0 && (
              <select
                className="rounded border border-border bg-background px-1.5 py-1"
                value={targetId ?? ''}
                onChange={(e) => setTargetId(e.target.value || null)}
              >
                <option value="">
                  {translate(
                    'auto.components.right.sidebar.ormReview.noTarget',
                    'No target selected'
                  )}
                </option>
                {status.targets.map((target) => (
                  <option key={target.targetId} value={target.targetId}>
                    {target.label} — {target.redactedUrl}
                  </option>
                ))}
              </select>
            )}
            <div className="flex gap-1">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1"
                placeholder={translate(
                  'auto.components.right.sidebar.ormReview.targetLabel',
                  'Label (e.g. bookmarks-dev)'
                )}
                value={targetLabel}
                onChange={(e) => setTargetLabel(e.target.value)}
              />
              <input
                className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1"
                placeholder="postgresql://…"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
              />
              <button
                type="button"
                className="rounded border border-border px-2 text-muted-foreground hover:text-foreground"
                onClick={() => void addTarget()}
              >
                {translate('auto.components.right.sidebar.ormReview.addTarget', 'Add')}
              </button>
            </div>
            <span className="text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.ormReview.targetNote',
                'Targets are held runtime-side for this session and are never sent to agents.'
              )}
            </span>
          </section>

          <section className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {translate('auto.components.right.sidebar.ormReview.declaredModel', 'Declared model')}
            </span>
            {status.declaredModel.state === 'ok' ? (
              <div className="rounded border border-border p-1.5">
                <div className="text-muted-foreground">{status.declaredModel.schemaPath}</div>
                <div>{status.declaredModel.modelNames.join(', ') || '(no models)'}</div>
              </div>
            ) : (
              <StateBadge state={status.declaredModel.state} />
            )}
          </section>

          <section className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {translate('auto.components.right.sidebar.ormReview.migrations', 'Migration history')}
            </span>
            {status.migrationHistory.state === 'ok' ? (
              <div className="flex flex-col gap-0.5 rounded border border-border p-1.5">
                {status.migrationHistory.entries.length === 0 && (
                  <span className="text-muted-foreground">(no migrations)</span>
                )}
                {status.migrationHistory.entries.map((migration) => (
                  <div key={migration.name} className="flex items-center justify-between gap-2">
                    <span className="truncate">{migration.name}</span>
                    <span className="flex items-center gap-1">
                      {migration.destructive && (
                        <span className="text-[10px] text-amber-500">destructive?</span>
                      )}
                      <StateBadge state={migration.status} />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <StateBadge state={status.migrationHistory.state} />
            )}
          </section>

          <section className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {translate('auto.components.right.sidebar.ormReview.observed', 'Observed database')}
            </span>
            {status.observedDatabase.state === 'ok' ? (
              <div className="rounded border border-border p-1.5">
                <div>{status.observedDatabase.target.redactedUrl}</div>
                <div className="text-muted-foreground">
                  {translate('auto.components.right.sidebar.ormReview.observedAt', 'Verified at')}{' '}
                  {new Date(status.observedDatabase.observedAt).toLocaleString()}
                </div>
                <div>
                  {status.observedDatabase.pendingMigrations.length === 0
                    ? translate('auto.components.right.sidebar.ormReview.upToDate', 'Up to date')
                    : `${status.observedDatabase.pendingMigrations.length} pending`}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <StateBadge state={status.observedDatabase.state} />
                <span className="text-[10px] text-muted-foreground">
                  {'reason' in status.observedDatabase ? status.observedDatabase.reason : ''}
                </span>
              </div>
            )}
          </section>

          <section className="flex flex-wrap gap-1">
            {RUN_COMMANDS.map(([command, label]) => (
              <button
                key={command}
                type="button"
                className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={!selectedTarget || running !== null}
                onClick={() => void runCommand(command)}
              >
                {running === command ? '…' : label}
              </button>
            ))}
          </section>

          <OrmReviewEvidenceSection
            evidence={status.evidence}
            question={question}
            onQuestionChange={setQuestion}
            onPreparePacket={(evidenceId) => void preparePacket(evidenceId)}
          />

          {packet && (
            <OrmReviewPacketPreview
              worktreeId={worktreeId}
              packet={packet}
              onClose={() => setPacket(null)}
            />
          )}
        </>
      )}
    </div>
  )
}
