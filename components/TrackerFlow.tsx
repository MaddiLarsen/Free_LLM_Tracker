'use client'

/**
 * The whole front end, in three steps.
 *
 *   1. setup    - enter your brand and (optionally) your website
 *   2. review   - write your own prompts, or ask for starter suggestions, then run
 *   3. running  - fire them at the engines, then redirect to the report
 *
 * There is no competitor anything here. The only question is whether the brand
 * shows up - especially in prompts that never name it.
 *
 * The running step calls /run in a loop. Each call does exactly one prompt. Two
 * loops run side by side so it finishes roughly twice as fast without tripping
 * the AI Gateway's rate limits.
 */

import { useCallback, useRef, useState } from 'react'
import { mentionsBrand } from '@/lib/tracker/brand-match'

type Step = 'setup' | 'review' | 'running'

/** A prompt as the user is editing it. Its branded/unbranded tag is derived. */
interface DraftPrompt {
  text: string
}

/** How many /run calls to keep in flight at once. */
const PARALLEL = 2

export default function TrackerFlow() {
  const [step, setStep] = useState<Step>('setup')
  const [error, setError] = useState('')

  // step 1
  const [brand, setBrand] = useState('')
  const [website, setWebsite] = useState('')

  // step 2
  const [prompts, setPrompts] = useState<DraftPrompt[]>([])
  const [suggesting, setSuggesting] = useState(false)
  const [recurring, setRecurring] = useState(false)

  // step 3
  const [auditId, setAuditId] = useState('')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const cancelled = useRef(false)

  const isBranded = (text: string) => Boolean(text.trim()) && mentionsBrand(text, brand)
  const filled = prompts.filter((p) => p.text.trim())
  const brandedCount = filled.filter((p) => isBranded(p.text)).length
  const unbrandedCount = filled.length - brandedCount

  // --- step 1 -> 2 ----------------------------------------------------------
  function handleContinue(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!brand.trim()) {
      setError('Enter your brand name.')
      return
    }
    // Start them with one empty row to type into.
    if (prompts.length === 0) setPrompts([{ text: '' }])
    setStep('review')
  }

  // --- step 2: optional suggestions -----------------------------------------
  async function handleSuggest() {
    setError('')
    setSuggesting(true)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand, website }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not suggest prompts.')

      const suggested = (data.prompts as Array<{ text: string }>).map((p) => ({ text: p.text }))
      // Keep anything the user already typed, drop the empty starter row.
      setPrompts((prev) => [...prev.filter((p) => p.text.trim()), ...suggested])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not suggest prompts.')
    } finally {
      setSuggesting(false)
    }
  }

  // --- step 3: the run loop -------------------------------------------------
  const drain = useCallback(async (id: string) => {
    async function worker() {
      while (!cancelled.current) {
        const res = await fetch(`/api/audits/${id}/run`, { method: 'POST' })
        const data = (await res.json()) as {
          error?: string
          finished?: boolean
          waiting?: boolean
          done?: number
          total?: number
        }

        if (!res.ok) {
          cancelled.current = true
          throw new Error(data.error ?? 'Run failed.')
        }

        setProgress({ done: data.done ?? 0, total: data.total ?? 0 })

        if (data.finished) return
        if (data.waiting) await new Promise((r) => setTimeout(r, 1500))
      }
    }

    await Promise.all(Array.from({ length: PARALLEL }, () => worker()))
  }, [])

  async function handleRun() {
    setError('')
    setStep('running')
    cancelled.current = false
    try {
      const res = await fetch('/api/audits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand,
          website,
          prompts: filled.map((p) => ({ text: p.text.trim() })),
          recurring,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not start the run.')

      setAuditId(data.id)
      setProgress({ done: 0, total: data.totalPrompts })

      await drain(data.id)
      window.location.href = `/a/${data.id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed.')
      setStep('review')
    }
  }

  // --- prompt editing -------------------------------------------------------
  function updatePrompt(i: number, text: string) {
    setPrompts((prev) => prev.map((p, idx) => (idx === i ? { text } : p)))
  }
  function removePrompt(i: number) {
    setPrompts((prev) => prev.filter((_, idx) => idx !== i))
  }
  function addPrompt() {
    setPrompts((prev) => [...prev, { text: '' }])
  }

  // =========================================================================

  if (step === 'setup') {
    return (
      <div className="max-w-2xl">
        <h1 className="mb-3 text-3xl font-semibold tracking-tight">
          See if AI mentions your brand
        </h1>
        <p className="mb-10 text-muted">
          Write the questions you care about, send them to five AI models, and find out whether your
          brand shows up - especially in questions that never name you. That is the whole tool.
        </p>

        <form onSubmit={handleContinue} className="space-y-6">
          <div>
            <label className="label mb-2 block">Brand name</label>
            <input
              className="field"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Notion"
              required
            />
            <p className="mt-2 text-sm text-muted">
              Exactly how it is written. This is the word we look for in every answer.
            </p>
          </div>

          <div>
            <label className="label mb-2 block">Website (optional)</label>
            <input
              className="field"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="notion.so"
            />
            <p className="mt-2 text-sm text-muted">
              Lets us also check when a model links to your own site, and sharpens the suggestions.
            </p>
          </div>

          {error && <p className="border border-ink px-4 py-3 text-sm">{error}</p>}

          <button className="btn">Continue to prompts</button>
        </form>
      </div>
    )
  }

  if (step === 'review') {
    return (
      <div>
        <div className="mb-10 grid gap-6 border border-line p-6 sm:grid-cols-2">
          <div>
            <p className="label mb-1">Brand</p>
            <p className="font-medium">{brand}</p>
          </div>
          <div>
            <p className="label mb-1">Website</p>
            <p className="font-medium">{website || '-'}</p>
          </div>
        </div>

        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Write your prompts</h2>
            <p className="mt-1 text-sm text-muted">
              Type the real questions people ask. Each one is tagged automatically: branded if it
              names you, unbranded if it does not. Unbranded is the one that counts.
            </p>
          </div>
          <p className="label">
            {brandedCount} branded &middot; {unbrandedCount} unbranded
          </p>
        </div>

        <ul className="mb-6 divide-y divide-line border-y border-line">
          {prompts.map((p, i) => {
            const branded = isBranded(p.text)
            return (
              <li key={i} className="flex items-center gap-3 py-2">
                <span
                  className={`w-28 shrink-0 text-center font-mono text-xs uppercase tracking-wider ${
                    p.text.trim() ? '' : 'text-muted'
                  }`}
                >
                  {p.text.trim() ? (branded ? 'Branded' : 'Unbranded') : '-'}
                </span>
                <input
                  className="field border-0"
                  value={p.text}
                  onChange={(e) => updatePrompt(i, e.target.value)}
                  placeholder="Type a question someone would ask an AI"
                />
                <button
                  type="button"
                  onClick={() => removePrompt(i)}
                  className="shrink-0 px-2 text-muted hover:text-ink"
                  aria-label="Remove prompt"
                >
                  &times;
                </button>
              </li>
            )
          })}
        </ul>

        <div className="mb-10 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost" onClick={addPrompt}>
            + Add prompt
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleSuggest} disabled={suggesting}>
            {suggesting ? 'Thinking of prompts...' : 'Suggest starter prompts'}
          </button>
        </div>

        <div className="mb-10 border border-line p-6">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
            />
            <span>
              Run this same prompt set every week
              <span className="mt-1 block text-muted">
                One run is a snapshot. Repeating the exact same questions is what turns it into a
                trend you can act on. Costs the same as this run, once a week. Only runs once
                deployed with a CRON_SECRET set.
              </span>
            </span>
          </label>
        </div>

        {error && <p className="mb-6 border border-ink px-4 py-3 text-sm">{error}</p>}

        <div className="flex flex-wrap items-center gap-4">
          <button className="btn" onClick={handleRun} disabled={filled.length === 0}>
            Run the tracker
          </button>
          <button className="btn btn-ghost" onClick={() => setStep('setup')}>
            Back
          </button>
          <p className="text-sm text-muted">
            {filled.length} prompts across every engine. Takes a few minutes.
          </p>
        </div>
      </div>
    )
  }

  // step === 'running'
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  const reportUrl =
    typeof window === 'undefined' ? `/a/${auditId}` : `${window.location.origin}/a/${auditId}`

  return (
    <div className="max-w-2xl">
      <h2 className="mb-3 text-2xl font-semibold tracking-tight">Running</h2>
      <p className="mb-8 text-muted">
        Every prompt is being sent to every engine, and every answer is being read. Keep this tab
        open.
      </p>

      <div className="mb-3 h-px w-full bg-line">
        <div className="h-px bg-ink transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="label">
        {progress.done} of {progress.total} prompts &middot; {pct}%
      </p>

      {auditId && (
        <div className="mt-8 text-sm text-muted">
          <p className="mb-2">
            Bookmark your report link. It keeps working after this finishes, and if you turned on
            weekly runs, every future run appears on this same page as a trend.
          </p>
          <a className="break-all font-mono text-xs underline" href={`/a/${auditId}`}>
            {reportUrl}
          </a>
        </div>
      )}

      {error && <p className="mt-6 border border-ink px-4 py-3 text-sm">{error}</p>}
    </div>
  )
}
