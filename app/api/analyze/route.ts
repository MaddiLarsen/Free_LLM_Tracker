/**
 * POST /api/analyze
 *
 * The optional prompt suggester. Give it a brand name (and optionally a
 * website), get back a starter set of prompts, branded and unbranded. Nothing
 * is saved - the user edits, adds, and deletes before running, because THEY
 * know their market better than a model does.
 */
import { NextRequest, NextResponse } from 'next/server'
import { suggestPrompts } from '@/lib/tracker/analyzer'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      brand?: string
      website?: string
      notes?: string
    }

    const brand = body.brand?.trim()
    if (!brand) {
      return NextResponse.json({ error: 'Enter your brand name.' }, { status: 400 })
    }

    const result = await suggestPrompts({ brand, website: body.website, notes: body.notes })

    if (result.prompts.length === 0) {
      return NextResponse.json(
        { error: 'Could not suggest prompts for that brand. Try adding a website.' },
        { status: 502 }
      )
    }

    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Suggestion failed.' },
      { status: 500 }
    )
  }
}
