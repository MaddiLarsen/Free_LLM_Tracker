/**
 * POST /api/audits
 *
 * The user has written their prompts. Save the audit and its prompt list, hand
 * back an id. Nothing is run yet.
 *
 * Each prompt is tagged branded or unbranded HERE, from its text, using the
 * same matcher that counts mentions in answers. That way the label a prompt
 * carries and the counting done on its answers can never disagree.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase'
import { normalizeWebsite } from '@/lib/tracker/analyze'
import { mentionsBrand } from '@/lib/tracker/brand-match'
import type { PromptType } from '@/lib/tracker/types'

export const runtime = 'nodejs'

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      brand?: string
      website?: string
      prompts?: Array<{ text?: string }>
      recurring?: boolean
    }

    const brand = body.brand?.trim()
    if (!brand) return NextResponse.json({ error: 'Brand name is required.' }, { status: 400 })

    const brandDomain = normalizeWebsite(body.website)

    const prompts = (body.prompts ?? [])
      .map((p) => String(p.text ?? '').trim())
      .filter(Boolean)
      .slice(0, 60)
      .map((text): { text: string; type: PromptType } => ({
        text,
        type: mentionsBrand(text, brand, brandDomain) ? 'branded' : 'unbranded',
      }))

    if (prompts.length === 0) {
      return NextResponse.json({ error: 'Add at least one prompt.' }, { status: 400 })
    }

    const admin = createAdminClient()

    const { data: audit, error: auditErr } = await admin
      .from('audits')
      .insert({
        brand,
        website: brandDomain,
        status: 'review',
        total_prompts: prompts.length,
        // Marking it recurring makes the weekly cron re-run this exact prompt
        // set. last_run_at starts now so the first repeat is a week away, not
        // on the next cron tick.
        recurring: Boolean(body.recurring),
        last_run_at: body.recurring ? new Date().toISOString() : null,
      })
      .select('id')
      .single()

    if (auditErr || !audit) {
      return NextResponse.json({ error: auditErr?.message ?? 'Could not create audit.' }, { status: 500 })
    }

    const { error: promptErr } = await admin.from('audit_prompts').insert(
      prompts.map((p, idx) => ({
        audit_id: audit.id,
        idx,
        prompt: p.text,
        type: p.type,
        status: 'pending',
      }))
    )

    if (promptErr) {
      // Clean up the orphan so a failed save does not leave a dead audit behind.
      await admin.from('audits').delete().eq('id', audit.id)
      return NextResponse.json({ error: promptErr.message }, { status: 500 })
    }

    return NextResponse.json({ id: audit.id, totalPrompts: prompts.length })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not create audit.' },
      { status: 500 }
    )
  }
}
