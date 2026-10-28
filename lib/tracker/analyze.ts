/**
 * Scoring. Once an engine has answered, this file works out what the answer
 * said about you.
 *
 * Two layers, on purpose:
 *
 *  1. Code decides whether you were mentioned. A literal word-boundary count,
 *     from brand-match.ts. Boring, but it is never wrong.
 *  2. An LLM "judge" decides the one fuzzy thing left - how you were described.
 *     Tone needs judgement, so a model does it.
 *
 * Do not let the judge decide whether you were mentioned. It hallucinates your
 * brand, it scores look-alike names (a brand called "Notio" credited for every
 * mention of "Notion"), and it counts the brand name from the question as if it
 * had appeared in the answer. Counting is the code's job and stays that way.
 */
import { callGateway } from './gateway'
import { countBrandMentions } from './brand-match'
import type { Citation, EngineResult, Report, Sentiment } from './types'

/** Cheap, reliable model for scoring. It only has to read and return JSON. */
const JUDGE_MODEL = process.env.TRACKER_MODEL_JUDGE ?? 'openai/gpt-4o-mini'

// --- URL + brand helpers --------------------------------------------------

export function toDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Accepts "example.com", "https://example.com/path", "www.example.com". */
export function normalizeWebsite(website?: string | null): string | null {
  if (!website?.trim()) return null
  const raw = website.trim()
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const domain = toDomain(withProto)
  return domain || null
}

export function isBrandDomain(domain: string, brandDomain: string | null): boolean {
  if (!brandDomain || !domain) return false
  return domain === brandDomain || domain.endsWith(`.${brandDomain}`)
}

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/gi

/** Pulls clean, deduped URLs out of free text (trailing punctuation stripped). */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of found) {
    const cleaned = m.replace(/[.,;:!?)\]}'"]+$/, '')
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned)
      out.push(cleaned)
    }
  }
  return out
}

export function makeCitation(url: string, brandDomain: string | null): Citation {
  const domain = toDomain(url)
  return { url, domain, isBrand: isBrandDomain(domain, brandDomain) }
}

/** Pulls a JSON object out of a model reply that may be fenced or chatty. */
export function stripToJson(raw: string): string {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1)
  return s
}

// --- the judge ------------------------------------------------------------

export interface JudgeOutput {
  sentiment: Sentiment
  costUsd: number
}

const EMPTY_JUDGE: JudgeOutput = { sentiment: 'not_mentioned', costUsd: 0 }

/**
 * Reads tone only. We tell it the brand was mentioned (code already decided
 * that) and ask one question: how is the brand described here. Everything about
 * counting, ranking and other brands is deliberately not its job.
 */
export async function judgeResponse(params: {
  prompt: string
  brand: string
  website: string | null
  answer: string
}): Promise<JudgeOutput> {
  const { prompt, brand, website, answer } = params
  if (!answer.trim()) return EMPTY_JUDGE

  const system =
    'You read an AI assistant answer and judge how a specific brand is described in it. ' +
    'Return ONLY raw JSON (no markdown, no code fences, no prose). ' +
    'Judge tone toward the brand only, from what the answer actually says.'

  const user = [
    `USER PROMPT:\n${prompt}`,
    `\nBRAND: ${brand}${website ? ` (website: ${website})` : ''}`,
    `\nASSISTANT ANSWER:\n"""\n${answer.slice(0, 12000)}\n"""`,
    `\nReturn JSON with exactly this key:`,
    `{`,
    `  "sentiment": "positive" | "neutral" | "negative"  // tone toward ${brand} specifically`,
    `}`,
  ].join('\n')

  try {
    const res = await callGateway(
      JUDGE_MODEL,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { maxTokens: 64 }
    )

    const parsed = JSON.parse(stripToJson(res.text)) as { sentiment?: string }
    const sentiment: Sentiment = (['positive', 'neutral', 'negative'] as const).includes(
      parsed.sentiment as 'positive' | 'neutral' | 'negative'
    )
      ? (parsed.sentiment as Sentiment)
      : 'neutral'

    return { sentiment, costUsd: res.costUsd }
  } catch {
    // Judge failed. Neutral is the safe default - we still know you were
    // mentioned, we just will not claim to know the tone.
    return { sentiment: 'neutral', costUsd: 0 }
  }
}

/** Folds the judge's tone into one engine result, with code as the referee. */
export function applyJudge(
  engine: EngineResult,
  judge: JudgeOutput,
  brand: string,
  brandDomain?: string | null
): void {
  const literalCount = countBrandMentions(engine.text, brand, brandDomain)
  const mentioned = literalCount > 0

  engine.brandMentioned = mentioned
  engine.mentionCount = literalCount
  engine.sentiment = mentioned ? (judge.sentiment === 'not_mentioned' ? 'neutral' : judge.sentiment) : 'not_mentioned'
  engine.brandCitationCount = engine.citations.filter((c) => c.isBrand).length
}

// --- one prompt, all engines, rolled up -----------------------------------

export function buildReport(
  base: Pick<Report, 'prompt' | 'brand' | 'website' | 'createdAt'>,
  engines: EngineResult[]
): Report {
  const answered = engines.filter((e) => e.status === 'success')
  const denom = answered.length || 1

  const mentioned = answered.filter((e) => e.brandMentioned)
  const mentionRate = answered.length ? mentioned.length / denom : 0

  const citingBrand = answered.filter((e) => e.brandCitationCount > 0)
  const citationRate = answered.length ? citingBrand.length / denom : 0

  const sentimentBreakdown: Record<Sentiment, number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
    not_mentioned: 0,
  }
  for (const e of answered) sentimentBreakdown[e.sentiment]++

  // Every source the models linked to, merged, brand-owned pages first.
  const urlMap = new Map<string, Report['citedUrls'][number]>()
  for (const e of engines) {
    for (const c of e.citations) {
      const existing = urlMap.get(c.url)
      if (existing) {
        existing.count++
        if (!existing.engines.includes(e.id)) existing.engines.push(e.id)
      } else {
        urlMap.set(c.url, { url: c.url, domain: c.domain, isBrand: c.isBrand, engines: [e.id], count: 1 })
      }
    }
  }
  const citedUrls = Array.from(urlMap.values()).sort(
    (a, b) => Number(b.isBrand) - Number(a.isBrand) || b.engines.length - a.engines.length || b.count - a.count
  )

  return {
    ...base,
    engines,
    enginesAnswered: answered.length,
    mentionRate,
    citationRate,
    sentimentBreakdown,
    citedUrls,
    totalCostUsd: engines.reduce((sum, e) => sum + e.costUsd, 0),
  }
}
