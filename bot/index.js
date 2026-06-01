import { Telegraf } from 'telegraf'
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()

const bot = new Telegraf(process.env.BOT_TOKEN)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)

const CHANNEL_ID = process.env.CHANNEL_ID   // e.g. -1001234567890
const ADMIN_IDS  = (process.env.ADMIN_IDS ?? '').split(',').map(Number)

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAdmin(userId) {
  console.log('Checking admin for user ID:', userId)
  console.log('Admin IDs:', ADMIN_IDS)
  return ADMIN_IDS.includes(userId)
}

/** Upsert a Telegram user into our users table */
async function upsertUser(from) {
  await supabase.from('users').upsert({
    telegram_user_id: from.id,
    username:   from.username   ?? null,
    first_name: from.first_name ?? null,
    last_name:  from.last_name  ?? null,
    last_active_at: new Date().toISOString(),
  }, { onConflict: 'telegram_user_id' })
}

/** Find which card a discussion reply belongs to via the thread's root message */
async function getCardByThread(ctx) {
  // In a discussion group, message_thread_id is the id of the channel post
  // that opened the thread (forwarded into the linked group).
  const threadId = ctx.message?.message_thread_id
  console.log('looking up thread id:', threadId)
  if (!threadId) return null

    const { data: all } = await supabase
    .from('discussion_posts')
    .select('telegram_message_id, card_id')
  console.log('all discussion_posts:', all)

  const { data } = await supabase
    .from('discussion_posts')
    .select('card_id, cards(*)')
    .eq('telegram_message_id', threadId)
    .single()

  return data ?? null
}

// ─── Admin: post all active unposted cards to the channel ───────────────────
// Usage: /postcards            → posts all active cards not yet posted
// Usage: /postcards <card_id>  → posts a single specific card

bot.command('postcards', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Admins only.')

  const specificId = ctx.message.text.split(' ')[1]?.trim()

  let query = supabase
    .from('available_cards')
    .select('id, name, price, quantity, front_image_url, back_image_url, category_name')

  if (specificId) {
    query = supabase
      .from('cards')
      .select('id, name, price, quantity, front_image_url, back_image_url, categories(name)')
      .eq('id', specificId)
      .eq('is_active', true)
  }

  const { data: cards, error } = await query
  if (error) return ctx.reply(`❌ DB error: ${error.message}`)
  if (!cards?.length) return ctx.reply('No cards to post. All active cards have already been posted, or no cards found.')

  await ctx.reply(`📤 Posting ${cards.length} card(s) to the channel...`)

  let posted = 0
  let failed = 0

  for (const card of cards) {
    try {
      const category = card.category_name ?? card.categories?.name ?? 'Uncategorised'
      const caption =
        `🃏 *${card.name}*\n` +
        `📂 ${category}\n` +
        `💰 *$${Number(card.price).toFixed(2)}*\n` +
        `📦 Stock: ${card.quantity}\n\n` +
        `💬 Comment *claim* to grab this card!\n` +
        `↩️ Comment *unclaim* to release it.`

      // ── Delete old channel post if one exists for this card ──
      const { data: existingPost } = await supabase
        .from('discussion_posts')
        .select('telegram_message_id')
        .eq('card_id', card.id)
        .single()

      if (existingPost) {
        try {
          await ctx.telegram.deleteMessage(CHANNEL_ID, existingPost.telegram_message_id)
        } catch (e) {
          console.log('could not delete old post:', e.message)
        }
        await supabase.from('discussion_posts').delete().eq('card_id', card.id)
      }

      // ── Post the card ──
      let sentMessage

      if (card.front_image_url && card.back_image_url) {
        const mediaGroup = await ctx.telegram.sendMediaGroup(CHANNEL_ID, [
          { type: 'photo', media: card.front_image_url, caption, parse_mode: 'Markdown' },
          { type: 'photo', media: card.back_image_url },
        ])
        sentMessage = mediaGroup[0]
      } else if (card.front_image_url) {
        sentMessage = await ctx.telegram.sendPhoto(CHANNEL_ID, card.front_image_url, {
          caption,
          parse_mode: 'Markdown',
        })
      } else {
        sentMessage = await ctx.telegram.sendMessage(CHANNEL_ID, caption, {
          parse_mode: 'Markdown',
        })
      }

      // ── Insert fresh discussion_posts row with new channel message id ──
      await supabase.from('discussion_posts').insert({
        telegram_message_id: sentMessage.message_id,
        card_id: card.id,
      })

      posted++
      await new Promise(r => setTimeout(r, 1500))

    } catch (err) {
      console.error(`Failed to post card ${card.id}:`, err.message)
      failed++
    }
  }

  ctx.reply(`✅ Done! Posted: ${posted} card(s)` + (failed ? ` | ❌ Failed: ${failed}` : ''))
})

// ─── Claim ──────────────────────────────────────────────────────────────────

bot.hears(/^claim$/i, async (ctx) => {
  if (!ctx.message?.message_thread_id) return

  const chatId = ctx.message.chat.id
  const replyTo = { reply_parameters: { message_id: ctx.message.message_id } }

  await upsertUser(ctx.from)

  const post = await getCardByThread(ctx)
  if (!post) return

  const { cards: card } = post
  const userId = ctx.from.id
  const name = ctx.from.first_name ?? ctx.from.username ?? 'User'

  if (!card.is_active) {
    return ctx.telegram.sendMessage(chatId, `❌ This card is no longer available.`, replyTo)
  }
  if (card.quantity < 1) {
    return ctx.telegram.sendMessage(chatId, `❌ Sorry, *${card.name}* is out of stock.`, { parse_mode: 'Markdown', ...replyTo })
  }

  const { data: existing } = await supabase
    .from('claims')
    .select('telegram_user_id')
    .eq('card_id', card.id)
    .single()

  if (existing) {
    if (existing.telegram_user_id === userId) {
      return ctx.telegram.sendMessage(chatId, `ℹ️ You already have *${card.name}* claimed.`, { parse_mode: 'Markdown', ...replyTo })
    }
    return ctx.telegram.sendMessage(chatId, `❌ *${card.name}* has already been claimed.`, { parse_mode: 'Markdown', ...replyTo })
  }

  const { error } = await supabase.from('claims').insert({
    card_id:          card.id,
    telegram_user_id: userId,
  })

  if (error) return ctx.telegram.sendMessage(chatId, `❌ Could not save claim. Try again.`, replyTo)

  ctx.telegram.sendMessage(chatId, `✅ *${card.name}* claimed by ${name}! 🎉\nType /invoice in DM to see your cart.`, { parse_mode: 'Markdown', ...replyTo })
})

// ─── Unclaim ─────────────────────────────────────────────────────────────────
bot.hears(/^unclaim$/i, async (ctx) => {
  if (!ctx.message?.message_thread_id) return

  const chatId = ctx.message.chat.id
  const replyTo = { reply_parameters: { message_id: ctx.message.message_id } }

  const post = await getCardByThread(ctx)
  if (!post) return

  const { cards: card } = post
  const userId = ctx.from.id

  const { data: claim } = await supabase
    .from('claims')
    .select('id, telegram_user_id')
    .eq('card_id', card.id)
    .single()

  if (!claim) {
    return ctx.telegram.sendMessage(chatId, `ℹ️ *${card.name}* has no active claim.`, { parse_mode: 'Markdown', ...replyTo })
  }
  if (claim.telegram_user_id !== userId) {
    return ctx.telegram.sendMessage(chatId, `❌ You didn't claim *${card.name}*.`, { parse_mode: 'Markdown', ...replyTo })
  }

  await supabase.from('claims').delete().eq('id', claim.id)

  ctx.telegram.sendMessage(chatId, `↩️ Claim on *${card.name}* removed.`, { parse_mode: 'Markdown', ...replyTo })
})

bot.command('release', async (ctx) => {
  await upsertUser(ctx.from)
  const userId = ctx.from.id

  const { data: claims, error } = await supabase
    .from('claims')
    .select('id, cards(name)')
    .eq('telegram_user_id', userId)

  if (error) return ctx.reply('❌ Could not fetch your claims. Try again.')
  if (!claims?.length) return ctx.reply('ℹ️ You have no active claims to release.')

  await supabase.from('claims').delete().eq('telegram_user_id', userId)

  const cardNames = claims.map(c => `• ${c.cards.name}`).join('\n')
  ctx.reply(`↩️ Released all your claims:\n\n${cardNames}`, { parse_mode: 'Markdown' })
})

// ─── /invoice ────────────────────────────────────────────────────────────────
// Works in both DM and group — always sends the reply as a private DM

bot.command('invoice', async (ctx) => {
  await upsertUser(ctx.from)

  const userId = ctx.from.id

  const { data: claims, error } = await supabase
    .from('claims')
    .select('id, cards(id, name, price, front_image_url)')
    .eq('telegram_user_id', userId)

  if (error) return ctx.telegram.sendMessage(userId, '❌ Could not fetch your claims. Try again.')

  if (!claims || claims.length === 0) {
    return ctx.telegram.sendMessage(userId, "🛒 You haven't claimed any cards yet.\n\nComment *claim* under a card listing to grab one.", { parse_mode: 'Markdown' })
  }

  const total = claims.reduce((sum, c) => sum + Number(c.cards.price), 0)

  const lines = claims.map((c, i) =>
    `${i + 1}. *${c.cards.name}* — $${Number(c.cards.price).toFixed(2)}`
  ).join('\n')

  const msg =
    `🧾 *Your Invoice*\n\n` +
    `${lines}\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `*Total: $${total.toFixed(2)}*\n\n` +
    `Reply with your payment reference once you've transferred, or contact the seller to confirm.`

  await ctx.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' })

  // If the command was used in a group, acknowledge there
  if (ctx.chat.type !== 'private') {
    ctx.reply(`📩 Invoice sent to your DM, ${ctx.from.first_name}!`)
  }
})

// ─── Admin: mark order as paid ───────────────────────────────────────────────
// Usage: /markpaid <telegram_user_id>

bot.command('markpaid', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Admins only.')

  const targetId = Number(ctx.message.text.split(' ')[1])
  if (!targetId) return ctx.reply('Usage: /markpaid <telegram_user_id>')

  // Fetch user's claims
  const { data: claims } = await supabase
    .from('claims')
    .select('id, cards(id, name, price)')
    .eq('telegram_user_id', targetId)

  if (!claims?.length) return ctx.reply(`No active claims found for user ${targetId}.`)

  const total = claims.reduce((sum, c) => sum + Number(c.cards.price), 0)

  // Create order
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      telegram_user_id: targetId,
      status:           'paid',
      total_amount:     total,
      paid_at:          new Date().toISOString(),
    })
    .select()
    .single()

  if (orderError) return ctx.reply(`❌ Error creating order: ${orderError.message}`)

  // Insert order items and reduce stock
  for (const claim of claims) {
    await supabase.from('order_items').insert({
      order_id:   order.id,
      card_id:    claim.cards.id,
      quantity:   1,
      unit_price: claim.cards.price,
    })
    await supabase.rpc('decrement_quantity', { card_id: claim.cards.id })
  }

  // Clear claims
  await supabase.from('claims').delete().eq('telegram_user_id', targetId)

  // Notify the buyer
  const itemList = claims.map(c => `• ${c.cards.name}`).join('\n')
  await ctx.telegram.sendMessage(
    targetId,
    `✅ *Payment confirmed!* Thank you!\n\n*Order ID:* \`${order.id}\`\n\n${itemList}\n\n*Total paid: $${total.toFixed(2)}*`,
    { parse_mode: 'Markdown' }
  )

  ctx.reply(`✅ Order created and user notified. Order ID: ${order.id}`)
})

// ─── Admin: view all active claims ──────────────────────────────────────────

bot.command('claims', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Admins only.')

  const { data, error } = await supabase
    .from('claims')
    .select('telegram_user_id, users(first_name, username), cards(name, price)')
    .order('created_at', { ascending: true })

  if (error) return ctx.reply(`❌ ${error.message}`)
  if (!data?.length) return ctx.reply('No active claims.')

  const lines = data.map(c => {
    const user = c.users?.username ? `@${c.users.username}` : c.users?.first_name ?? c.telegram_user_id
    return `• *${c.cards.name}* ($${c.cards.price}) → ${user}`
  }).join('\n')

  ctx.reply(`📋 *Active Claims*\n\n${lines}`, { parse_mode: 'Markdown' })
})

// Listen for channel posts being forwarded into the discussion group
bot.on('message', async (ctx) => {
  // A forwarded channel post in the group has forward_from_chat matching the channel
  const fwd = ctx.message?.forward_from_chat
  if (!fwd || fwd.id.toString() !== CHANNEL_ID.toString()) return

  const originalChannelMessageId = ctx.message?.forward_from_message_id
  const groupThreadMessageId = ctx.message?.message_id

  console.log('channel post forwarded into group:', {
    originalChannelMessageId,
    groupThreadMessageId,
  })

  if (!originalChannelMessageId || !groupThreadMessageId) return

  // Find the discussion_post stored with the channel message id and update it
  const { error } = await supabase
    .from('discussion_posts')
    .update({ telegram_message_id: groupThreadMessageId })
    .eq('telegram_message_id', originalChannelMessageId)

  if (error) {
    console.log('failed to update thread id:', error.message)
  } else {
    console.log(`updated thread id: ${originalChannelMessageId} → ${groupThreadMessageId}`)
  }
})

// ─── Launch ──────────────────────────────────────────────────────────────────

// bot.launch()
// console.log('🤖 Bot is running...')
if (process.env.ENV === "dev") {
  bot.launch(); // Removed for Vercel serverless compatibility - using webhooks instead
}

process.once('SIGINT',  () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

export default bot;