/**
 * Shared types for the LLM visibility tracker.
 *
 * The shape of the whole app in one file. Read this first - everything else
 * is just code that fills these objects in.
 *
 * One "audit" = a set of prompts. Each prompt gets fired at every engine.
 * Each answer gets read. Then it all rolls up into one Aggregate. The only
 * question this tool answers is: does the brand show up, and how is it
 * described - never how it ranks against anyone else.
 */

export type EngineId = 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'grok'

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'not_mentioned'

export type EngineStatus = 'success' | 'empty' | 'error'

/**
 * The two kinds of prompt. This is worked out automatically from the prompt
 * text, not chosen by hand: a prompt that names the brand is branded, one that
 * does not is unbranded.
 *
 *  branded    - "Is Acme any good?"        You named yourself. Do the models agree?
 *  unbranded  - "Best CRM for startups"    Nobody named you. Do you show up anyway?
 *
 * Unbranded is the one that matters. Showing up only when someone already typed
 * your name is not visibility, it is recall.
 */
export type PromptType = 'branded' | 'unbranded'

export interface Citation {
  url: string
  domain: string
  /** true when this URL is on the tracked brand's own domain */
  isBrand: boolean
}

/** One engine's answer to one prompt, plus everything we read from it. */
export interface EngineResult {
  id: EngineId
  label: string
  /** the model id we actually called, e.g. "openai/gpt-5.3-chat" */
  model: string
  status: EngineStatus
  error?: string

  /** the full answer text, kept so you can read what the model actually said */
  text: string
  latencyMs: number
  /** real billed cost for this call, reported by the AI Gateway */
  costUsd: number

  citations: Citation[]

  // --- scoring ---
  /** the source of truth, from a literal count - not the judge */
  brandMentioned: boolean
  mentionCount: number
  /** how the brand was described, when it was mentioned */
  sentiment: Sentiment
  /** how many of this answer's links point at the brand's own domain */
  brandCitationCount: number
}

export interface AggregatedUrl {
  url: string
  domain: string
  isBrand: boolean
  engines: EngineId[]
  count: number
}

/** Everything we learned from firing ONE prompt at every engine. */
export interface Report {
  prompt: string
  brand: string
  website: string | null
  createdAt: string

  engines: EngineResult[]

  enginesAnswered: number
  /** engines that named you / engines that answered (0..1) */
  mentionRate: number
  /** engines that linked to your site / engines that answered (0..1) */
  citationRate: number
  sentimentBreakdown: Record<Sentiment, number>

  citedUrls: AggregatedUrl[]

  totalCostUsd: number
}

export interface GeneratedPrompt {
  text: string
  type: PromptType
}

/** What the suggester hands back. Just prompts - the brand is already known. */
export interface SuggestResult {
  prompts: GeneratedPrompt[]
}

/** One prompt inside an audit. */
export interface AuditPromptResult {
  id: string
  idx: number
  text: string
  type: PromptType
  status: 'pending' | 'running' | 'success' | 'error'
  report: Report | null
  error?: string
  costUsd: number
}

export interface EnginePerformance {
  id: EngineId
  label: string
  answered: number
  mentionRate: number
  citationRate: number
}

/** Visibility split by whether the prompt named the brand. */
export interface PromptGroupPerformance {
  type: PromptType
  prompts: number
  mentionRate: number
}

export interface PromptRowSummary {
  id: string
  text: string
  type: PromptType
  answered: number
  mentioned: number
  mentionRate: number
}

/** The final rollup across every prompt in the audit. */
export interface AuditAggregate {
  totalPrompts: number
  answeredPrompts: number
  mentionRate: number
  /** mention rate across only the prompts that did NOT name the brand */
  unbrandedMentionRate: number
  /** mention rate across only the prompts that DID name the brand */
  brandedMentionRate: number
  citationRate: number
  sentimentBreakdown: Record<Sentiment, number>
  perEngine: EnginePerformance[]
  perGroup: PromptGroupPerformance[]
  perPrompt: PromptRowSummary[]
  citedUrls: AggregatedUrl[]
  totalCostUsd: number
}

/** The audit row as the front end sees it. */
export interface AuditSummary {
  id: string
  brand: string
  website: string | null
  status: 'review' | 'running' | 'complete' | 'error'
  totalPrompts: number
  donePrompts: number
  aggregate: AuditAggregate | null
  createdAt: string
}

/**
 * Prompt types used to be brand / category / comparison. Old audits in the
 * database still carry those. Map them so an old report still reads sensibly:
 * "brand" was branded, everything else was effectively unbranded.
 */
export function coercePromptType(raw: string | null | undefined): PromptType {
  if (raw === 'branded' || raw === 'brand') return 'branded'
  return 'unbranded'
}
