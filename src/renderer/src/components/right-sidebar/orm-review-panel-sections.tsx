import React, { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { OrmReviewContextPacket, OrmReviewEvidenceView } from '../../../../shared/orm-review'
import { sendNotesToActiveAgentSession } from '@/lib/active-agent-note-send'
import { translate } from '@/i18n/i18n'

export function StateBadge({ state }: { state: string }): React.JSX.Element {
  const STATE_STYLES: Record<string, string> = {
    passed: 'text-emerald-500',
    failed: 'text-rose-500',
    running: 'text-amber-500',
    stale: 'text-muted-foreground line-through',
    unknown: 'text-muted-foreground',
    reconciling: 'text-amber-500',
    'not-checked': 'text-muted-foreground'
  }
  return (
    <span className={`text-[11px] font-medium ${STATE_STYLES[state] ?? 'text-muted-foreground'}`}>
      {state}
    </span>
  )
}

export function OrmReviewEvidenceSection({
  evidence,
  question,
  onQuestionChange,
  onPreparePacket
}: {
  evidence: OrmReviewEvidenceView[]
  question: string
  onQuestionChange: (value: string) => void
  onPreparePacket: (evidenceId: string) => void
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <span className="text-muted-foreground">
        {translate('auto.components.right.sidebar.ormReview.evidence', 'Verification evidence')}
      </span>
      {evidence.length === 0 && (
        <span className="text-muted-foreground">
          {translate('auto.components.right.sidebar.ormReview.noEvidenceYet', 'Nothing verified yet.')}
        </span>
      )}
      {evidence.map((record) => (
        <div key={record.evidenceId} className="rounded border border-border p-1.5">
          <div className="flex items-center justify-between gap-2">
            <span>{record.commandLabel}</span>
            <StateBadge state={record.effectiveState} />
          </div>
          <div className="text-[10px] text-muted-foreground">
            {record.kind} · {record.targetLabel ?? ''} ·{' '}
            {new Date(record.endedAt ?? record.startedAt).toLocaleString()}
          </div>
          {record.outputTail && (
            <pre className="scrollbar-sleek mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted p-1 text-[10px]">
              {record.outputTail}
            </pre>
          )}
          {(record.effectiveState === 'failed' || record.effectiveState === 'unknown') && (
            <button
              type="button"
              className="mt-1 rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => onPreparePacket(record.evidenceId)}
            >
              {translate(
                'auto.components.right.sidebar.ormReview.prepareSend',
                'Prepare “send to agent”'
              )}
            </button>
          )}
        </div>
      ))}
      <input
        className="rounded border border-border bg-background px-1.5 py-1"
        placeholder={translate(
          'auto.components.right.sidebar.ormReview.askPlaceholder',
          'Why did this migration fail?'
        )}
        value={question}
        onChange={(e) => onQuestionChange(e.target.value)}
      />
    </section>
  )
}

export function OrmReviewPacketPreview({
  worktreeId,
  packet,
  onClose
}: {
  worktreeId: string
  packet: OrmReviewContextPacket
  onClose: () => void
}): React.JSX.Element {
  const [sending, setSending] = useState(false)

  const sendPacket = useCallback(async () => {
    setSending(true)
    try {
      const result = await sendNotesToActiveAgentSession({
        worktreeId,
        prompt: packet.renderedText
      })
      if (result.status === 'sent') {
        toast.success(translate('auto.components.right.sidebar.ormReview.sent', 'Sent to agent.'))
        onClose()
      } else {
        toast.error(`Send failed: ${result.status}`)
      }
    } finally {
      setSending(false)
    }
  }, [worktreeId, packet, onClose])

  return (
    <div className="flex flex-col gap-1 rounded border border-border p-1.5">
      <span className="text-[10px] text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.ormReview.previewNote',
          'Preview — exactly this text goes to the current agent session:'
        )}
      </span>
      <pre className="scrollbar-sleek max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-1 text-[10px]">
        {packet.renderedText}
      </pre>
      <div className="flex gap-1">
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 hover:text-foreground disabled:opacity-50"
          disabled={sending}
          onClick={() => void sendPacket()}
        >
          {translate('auto.components.right.sidebar.ormReview.send', 'Send to current agent')}
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          {translate('auto.components.right.sidebar.ormReview.cancel', 'Cancel')}
        </button>
      </div>
      <span className="text-[10px] text-muted-foreground">
        evidence {packet.source.referenceId}
      </span>
    </div>
  )
}
