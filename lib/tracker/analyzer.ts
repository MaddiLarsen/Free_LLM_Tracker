/**
 * Prompt suggester: propose a starter set of prompts for a brand.
 *
 * Optional. The user writes their own prompts; this just gives them a running
 * start, because the hard part is thinking of good UNBRANDED questions - the
 * ones where the brand would want to appear without anyone naming it.
 *
 * If a website is given we read the homepage for context. If not, we work from
 * the brand name alone. Either way we never ask about competitors.
 *
 * We do not trust the model to label branded vs unbranded. We re-derive that
 * ourselves from the prompt text, so the label always matches how the rest of
 * the tool counts.
 */
import { callGateway } from './gateway'
import { normalizeWebsite, stripToJson } from './analyze'
import { mentionsBrand } from './brand-match'
import type { GeneratedPrompt, SuggestResult } from './types'

const ANALYZER_MODEL = process.env.TRACKER_MODEL_ANALYZER ?? 'openai/gpt-4o-mini'
const FETCH_TIMEOUT_MS = 15_000
const MAX_HOMEPAGE_CHARS = 6000

/** Default 15 keeps a run at roughly $0.10-$0.30. Raise it once it works. */
const TARGET_PROMPTS = Math.min(60, Math.max(3, Number(process.env.TRACKER_PROMPT_COUNT ?? '15')))

/** Crude but dependency-free HTML to text: drop script/style, strip tags. */
function htmlToText(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [
    titleMatch ? `TITLE: ${titleMatch[1].trim()}` : '',
    descMatch ? `DESCRIPTION: ${descMatch[1].trim()}` : '',
    body,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_HOMEPAGE_CHARS)
}

async function fetchHomepage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LlmTrackerBot/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!res.ok) return ''
    return htmlToText(await res.text())
  } catch {
    return ''
  }
}

export async function suggestPrompts(params: {
  brand: string
  website?: string
  notes?: string
}): Promise<SuggestResult> {
  const brand = params.brand.trim()
  const website = normalizeWebsite(params.website)
  const notes = (params.notes ?? '').trim().slice(0, 400)

  const homepage = website ? await fetchHomepage(`https://${website}`) : ''

  // Unbranded gets the larger share. That is where visibility is actually won
  // or lost, and the harder set to write by hand.
  const nBranded = Math.max(1, Math.round(TARGET_PROMPTS * 0.35))
  const nUnbranded = Math.max(1, TARGET_PROMPTS - nBranded)

  const system =
    'You help a brand check its visibility in AI assistant answers. From a brand name (and its ' +
    'website content if given) you write the prompts a real person would type into ChatGPT or ' +
    'Perplexity. Return ONLY raw JSON (no markdown, no code fences). Never mention competitors.'

  const user = [
    `BRAND: ${brand}`,
    website ? `WEBSITE: ${website}` : '',
    homepage
      ? `\nHOMEPAGE CONTENT:\n"""\n${homepage}\n"""`
      : `\n(No homepage content - infer the brand's category from its name.)`,
    `\nReturn JSON with exactly this key:`,
    `{`,
    `  "prompts": [ { "text": string, "type": "branded" | "unbranded" } ]`,
    `}`,
    `\nGenerate about ${TARGET_PROMPTS} prompts a real person would ask an AI assistant:`,
    `- about ${nBranded} "branded": questions that name ${brand} directly`,
    `  (what it is, is it any good, pricing, reviews, is it right for X).`,
    `- about ${nUnbranded} "unbranded": buying or research questions in ${brand}'s category`,
    `  where ${brand} would want to appear but is NOT named`,
    `  (e.g. "best X tools for Y", "how do I do Z"). Do NOT name ${brand} in these,`,
    `  and never name any other company.`,
    notes
      ? `\nFOCUS: weight the unbranded prompts toward these themes, use cases or topics: ${notes}.`
      : '',
    `\nMake them natural, varied, and specific to the real category. No numbering.`,
  ]
    .filter(Boolean)
    .join('\n')

  let parsed: { prompts?: Array<{ text?: string }> } = {}

  try {
    const res = await callGateway(
      ANALYZER_MODEL,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { maxTokens: 3000 }
    )
    parsed = JSON.parse(stripToJson(res.text))
  } catch (err) {
    throw new Error(`Could not suggest prompts. ${err instanceof Error ? err.message : 'Try again.'}`)
  }

  const seen = new Set<string>()
  const prompts: GeneratedPrompt[] = (parsed.prompts ?? [])
    .map((p) => String(p.text ?? '').trim())
    .filter((text) => {
      const key = text.toLowerCase()
      if (!text || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, TARGET_PROMPTS)
    // Label each prompt with our own matcher, not the model's claim.
    .map((text) => ({ text, type: mentionsBrand(text, brand, website) ? 'branded' : 'unbranded' }))

  return { prompts }
}
