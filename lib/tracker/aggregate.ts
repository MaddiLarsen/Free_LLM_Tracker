/**
 * The rollup. Takes every prompt's Report and combines them into the single
 * picture you actually look at: overall visibility, visibility split by whether
 * the prompt named you, which engines are worst, and how you were described.
 *
 * Every rate is measured per ANSWER, not per prompt. 15 prompts at 5 engines is
 * 75 answers, and "named in 30 of 75 answers" is the honest number.
 */
import type {
  AggregatedUrl,
  AuditAggregate,
  AuditPromptResult,
  EngineId,
  EnginePerformance,
  EngineResult,
  PromptGroupPerformance,
  PromptRowSummary,
  PromptType,
  Sentiment,
} from './types'

interface Answer {
  promptId: string
  type: PromptType
  engine: EngineResult
}

function rate(hits: number, of: number): number {
  return of > 0 ? hits / of : 0
}

export function aggregateAudit(prompts: AuditPromptResult[]): AuditAggregate {
  const done = prompts.filter((p) => p.report)
  const answers: Answer[] = []
  for (const p of done) {
    for (const e of p.report!.engines) {
      if (e.status === 'success') answers.push({ promptId: p.id, type: p.type, engine: e })
    }
  }

  const mentionRate = rate(answers.filter((a) => a.engine.brandMentioned).length, answers.length)
  const citationRate = rate(answers.filter((a) => a.engine.brandCitationCount > 0).length, answers.length)

  const sentimentBreakdown: Record<Sentiment, number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
    not_mentioned: 0,
  }
  for (const a of answers) sentimentBreakdown[a.engine.sentiment]++

  // Per engine. Tells you WHERE you are invisible.
  const engineMap = new Map<EngineId, { label: string; answered: number; mentioned: number; citing: number }>()
  for (const a of answers) {
    const e = a.engine
    const cur = engineMap.get(e.id) ?? { label: e.label, answered: 0, mentioned: 0, citing: 0 }
    cur.answered++
    if (e.brandMentioned) cur.mentioned++
    if (e.brandCitationCount > 0) cur.citing++
    engineMap.set(e.id, cur)
  }
  const perEngine: EnginePerformance[] = Array.from(engineMap.entries())
    .map(([id, v]) => ({
      id,
      label: v.label,
      answered: v.answered,
      mentionRate: rate(v.mentioned, v.answered),
      citationRate: rate(v.citing, v.answered),
    }))
    .sort((a, b) => b.mentionRate - a.mentionRate)

  // Branded vs unbranded. The whole point: do you show up when nobody named you?
  const GROUPS: PromptType[] = ['unbranded', 'branded']
  const perGroup: PromptGroupPerformance[] = GROUPS.map((type) => {
    const groupAnswers = answers.filter((a) => a.type === type)
    const promptIds = new Set(done.filter((p) => p.type === type).map((p) => p.id))
    return {
      type,
      prompts: promptIds.size,
      mentionRate: rate(groupAnswers.filter((a) => a.engine.brandMentioned).length, groupAnswers.length),
    }
  }).filter((g) => g.prompts > 0)

  const groupRate = (type: PromptType) => {
    const groupAnswers = answers.filter((a) => a.type === type)
    return rate(groupAnswers.filter((a) => a.engine.brandMentioned).length, groupAnswers.length)
  }

  // Per prompt, so you can find the exact questions you are invisible on.
  const perPrompt: PromptRowSummary[] = done.map((p) => {
    const r = p.report!
    const mentioned = r.engines.filter((e) => e.status === 'success' && e.brandMentioned).length
    return {
      id: p.id,
      text: p.text,
      type: p.type,
      answered: r.enginesAnswered,
      mentioned,
      mentionRate: r.mentionRate,
    }
  })

  // Every source the models cited, merged. This is "where the answer comes from".
  const urlMap = new Map<string, AggregatedUrl>()
  for (const p of done) {
    for (const u of p.report!.citedUrls) {
      const existing = urlMap.get(u.url)
      if (existing) {
        existing.count += u.count
        for (const id of u.engines) if (!existing.engines.includes(id)) existing.engines.push(id)
      } else {
        urlMap.set(u.url, { ...u, engines: [...u.engines] })
      }
    }
  }
  const citedUrls = Array.from(urlMap.values()).sort(
    (a, b) => Number(b.isBrand) - Number(a.isBrand) || b.engines.length - a.engines.length || b.count - a.count
  )

  return {
    totalPrompts: prompts.length,
    answeredPrompts: done.length,
    mentionRate,
    unbrandedMentionRate: groupRate('unbranded'),
    brandedMentionRate: groupRate('branded'),
    citationRate,
    sentimentBreakdown,
    perEngine,
    perGroup,
    perPrompt,
    citedUrls,
    totalCostUsd: prompts.reduce((sum, p) => sum + (p.costUsd || 0), 0),
  }
}
