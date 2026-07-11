import { Telegram } from 'telegraf'
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()

const telegram = new Telegram(process.env.BOT_TOKEN)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
const CHANNEL_ID = process.env.CHANNEL_ID

// Telegram allows ~20 messages/min per channel and a front+back card
// counts as 2 messages, so we post in batches at a compliant pace.
// Each batch runs in its own Vercel invocation (fresh 300s window) and
// chains the next batch via /api/postbatch.
export const PAGE_SIZE = 20
const DELAY_MS = 3000

export async function runPostcardsBatch({ categorySlug, page = 1, reportChatId, totals = { posted: 0, failed: 0 } }) {
  let query = supabase
    .from('available_cards')
    .select('id, name, price, quantity, front_image_url, back_image_url, category_name')
    .order('created_at', { ascending: true })

  let categoryLabel = null

  if (categorySlug) {
    const { data: category } = await supabase
      .from('categories')
      .select('id, name')
      .eq('slug', categorySlug)
      .single()

    if (!category) {
      return telegram.sendMessage(reportChatId, `❌ Unknown category: ${categorySlug}`)
    }
    categoryLabel = category.name
    query = query.eq('category_id', category.id)
  }

  const { data: cards, error } = await query
  if (error) return telegram.sendMessage(reportChatId, `❌ DB error: ${error.message}`)

  if (!cards?.length) {
    return telegram.sendMessage(
      reportChatId,
      categorySlug
        ? `No cards to post in <b>${categoryLabel}</b>. No active, unclaimed cards with stock in this category.`
        : 'No cards to post. No active, unclaimed cards with stock found.',
      { parse_mode: 'HTML' }
    )
  }

  const totalPages = Math.ceil(cards.length / PAGE_SIZE)
  const start = (page - 1) * PAGE_SIZE
  const batch = cards.slice(start, start + PAGE_SIZE)

  if (!batch.length) {
    return telegram.sendMessage(
      reportChatId,
      `❌ No cards in batch ${page}. There are ${cards.length} card(s) = ${totalPages} batch(es).`
    )
  }

  await telegram.sendMessage(
    reportChatId,
    (categorySlug
      ? `📤 Posting ${batch.length} card(s) from <b>${categoryLabel}</b> to the channel`
      : `📤 Posting ${batch.length} card(s) to the channel`) +
    (totalPages > 1 ? ` (batch ${page} of ${totalPages})` : '') + '...',
    { parse_mode: 'HTML' }
  )

  let posted = 0
  let failed = 0

  for (const card of batch) {
    try {
      const category = card.category_name ?? 'Uncategorised'
      // The 🃏 emoji carries a hidden deep-link with the card id so
      // claim/unclaim comments can identify the card without a DB mapping.
      const cardLink = `https://t.me/AllThingsTCGClaimsBot?start=card_${card.id}`
      const caption =
        `<a href="${cardLink}">🃏</a> <b>${card.name}</b>\n` +
        `📂 ${category}\n` +
        `💰 <b>$${Number(card.price).toFixed(2)}</b>\n` +
        `📦 Stock: ${card.quantity}\n\n` +
        `💬 Comment <b>claim</b> or <b>claim [qty]</b> to grab this card!\n` +
        `↩️ Comment <b>unclaim</b> or <b>unclaim [qty]</b> to release.`

      // Treat empty/whitespace-only URLs as missing
      const frontImage = card.front_image_url?.trim() || null
      const backImage  = card.back_image_url?.trim()  || null

      if (frontImage && backImage) {
        try {
          await telegram.sendMediaGroup(CHANNEL_ID, [
            { type: 'photo', media: frontImage, caption, parse_mode: 'HTML' },
            { type: 'photo', media: backImage },
          ])
        } catch (e) {
          // Back image may be broken/unreachable — fall back to front only
          console.log(`media group failed for card ${card.id}, retrying with front image only:`, e.message)
          await telegram.sendPhoto(CHANNEL_ID, frontImage, { caption, parse_mode: 'HTML' })
        }
      } else if (frontImage) {
        await telegram.sendPhoto(CHANNEL_ID, frontImage, { caption, parse_mode: 'HTML' })
      } else {
        await telegram.sendMessage(CHANNEL_ID, caption, { parse_mode: 'HTML' })
      }

      posted++
      await new Promise(r => setTimeout(r, DELAY_MS))

    } catch (err) {
      console.error(`Failed to post card ${card.id}:`, err.message)
      failed++
      // Honor Telegram's flood-control wait so subsequent cards don't also fail
      const retryAfter = err.response?.parameters?.retry_after
      if (retryAfter) await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000))
    }
  }

  totals.posted += posted
  totals.failed += failed

  if (page < totalPages) {
    await telegram.sendMessage(
      reportChatId,
      `✅ Batch ${page} of ${totalPages} done (${posted} posted${failed ? `, ${failed} failed` : ''}). Continuing...`
    )

    // Chain the next batch in a fresh invocation for a new 300s window.
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
    if (!host) {
      // Local dev: no timeout to dodge, just continue inline
      return runPostcardsBatch({ categorySlug, page: page + 1, reportChatId, totals })
    }

    try {
      const resp = await fetch(`https://${host}/api/postbatch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': process.env.BOT_TOKEN,
        },
        body: JSON.stringify({ categorySlug, page: page + 1, reportChatId, totals }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    } catch (e) {
      console.error('Failed to chain next batch:', e.message)
      const nextCmd = categorySlug ? `/postcards ${categorySlug} ${page + 1}` : `/postcards ${page + 1}`
      await telegram.sendMessage(
        reportChatId,
        `⚠️ Could not start batch ${page + 1} automatically. Run <code>${nextCmd}</code> to continue.`,
        { parse_mode: 'HTML' }
      )
    }
  } else {
    await telegram.sendMessage(
      reportChatId,
      `✅ All done! Posted: ${totals.posted} card(s)` + (totals.failed ? ` | ❌ Failed: ${totals.failed}` : '')
    )
  }
}
