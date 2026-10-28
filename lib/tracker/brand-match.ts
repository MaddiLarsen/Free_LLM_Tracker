/**
 * Brand matching, in one place and with no server dependencies.
 *
 * This decides whether a piece of text names the brand. It is used two ways:
 *
 *   1. On an answer, to count mentions. This is the source of truth for "did I
 *      show up", and nothing else is allowed to overrule it.
 *   2. On a prompt the user wrote, to label it branded or unbranded. A prompt
 *      that names the brand is a branded prompt; one that does not is unbranded,
 *      and unbranded visibility is the whole point of this tool.
 *
 * Both uses run the same literal matcher, so the label on a prompt and the
 * counting on an answer can never disagree about what "named" means. Because
 * there is nothing server-only in here, the browser can label prompts live as
 * the user types them.
 */

export function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|company|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A literal, word-boundary count of the brand name and, when it differs, the
 * root of its domain (so "linear" counts for "linear.app"). Boring on purpose:
 * a count that is always right beats a clever one that sometimes is not.
 */
export function countBrandMentions(text: string, brand: string, brandDomain?: string | null): number {
  if (!text) return 0
  const tokens: string[] = []
  const name = brand.trim()
  if (name) tokens.push(name)
  if (brandDomain) {
    const root = brandDomain.split('.')[0]
    if (root && root.length >= 3 && normName(root) !== normName(name)) tokens.push(root)
  }
  let count = 0
  for (const t of tokens) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(t)}(?![A-Za-z0-9])`, 'gi')
    count += (text.match(re) ?? []).length
  }
  return count
}

/** Does this text name the brand at all? The branded / unbranded test. */
export function mentionsBrand(text: string, brand: string, brandDomain?: string | null): boolean {
  return countBrandMentions(text, brand, brandDomain) > 0
}
