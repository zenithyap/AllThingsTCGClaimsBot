import { Telegraf, Markup } from 'telegraf'
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()

const PAYNOW_QR = 'https://gduougkrnrkpcqzcrbim.supabase.co/storage/v1/object/sign/Images/AllThingsTCGQRCode.jpg?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xYTUzNWY2Ni01ZDVlLTQ1M2ItYmFjYi01ZmY2YzI2MjFlN2IiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJJbWFnZXMvQWxsVGhpbmdzVENHUVJDb2RlLmpwZyIsImlhdCI6MTc4MDkwMjI1OCwiZXhwIjozMzU3NzAyMjU4fQ.USmHc1a-NwFBt5IOlSx5v3lI0tC0x0KLzizs4elVLT4'

const bot = new Telegraf(process.env.BOT_TOKEN)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)

const CHANNEL_ID          = process.env.CHANNEL_ID
const ADMIN_IDS           = (process.env.ADMIN_IDS ?? '').split(',').map(Number)
const ADMIN_USERNAME      = process.env.ADMIN_USERNAME
const ADMIN_GROUP_ID      = -1004210390133

const pendingAddress = new Map()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId)
}

async function upsertUser(from) {
  await supabase.from('users').upsert({
    telegram_user_id: from.id,
    username:         from.username   ?? null,
    first_name:       from.first_name ?? null,
    last_name:        from.last_name  ?? null,
    last_active_at:   new Date().toISOString(),
  }, { onConflict: 'telegram_user_id' })
}

async function getCardByThread(ctx) {
  const threadId = ctx.message?.message_thread_id
  if (!threadId) return null

  const { data } = await supabase
    .from('discussion_posts')
    .select('card_id, cards(*)')
    .eq('telegram_message_id', threadId)
    .single()

  return data ?? null
}

function buildInvoiceSummary(claims) {
  const grouped = {}
  for (const c of claims) {
    const key = c.cards.id
    if (!grouped[key]) {
      grouped[key] = { name: c.cards.name, price: Number(c.cards.price), qty: 0 }
    }
    grouped[key].qty++
  }
  const lines = Object.values(grouped).map((c, i) =>
    `${i + 1}. <b>${c.name}</b> x${c.qty} — $${(c.price * c.qty).toFixed(2)}`
  ).join('\n')
  const total = claims.reduce((sum, c) => sum + Number(c.cards.price), 0)
  return { lines, total }
}

// ─── /postcards ──────────────────────────────────────────────────────────────

bot.command('postcards', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Admins only.')

  const categorySlug = ctx.message.text.split(' ')[1]?.trim().toLowerCase()

  let query = supabase
    .from('available_cards')
    .select('id, name, price, quantity, front_image_url, back_image_url, category_name')

  let categoryLabel = null

  if (categorySlug) {
    const { data: category } = await supabase
      .from('categories')
      .select('id, name, slug')
      .eq('slug', categorySlug)
      .single()

    if (!category) {
      const { data: cats } = await supabase
        .from('categories')
        .select('name, slug')
        .order('name')

      const list = (cats ?? [])
        .map(c => `• <code>${c.slug}</code> — ${c.name}`)
        .join('\n')

      return ctx.reply(
        `❌ Unknown category: <code>${categorySlug}</code>\n\n` +
        `<b>Available categories:</b>\n${list}\n\n` +
        `Usage: <code>/postcards eng-vintage</code>`,
        { parse_mode: 'HTML' }
      )
    }

    categoryLabel = category.name
    query = query.eq('category_id', category.id)
  }

  const { data: cards, error } = await query
  if (error) return ctx.reply(`❌ DB error: ${error.message}`)
  if (!cards?.length) {
    return ctx.reply(
      categorySlug
        ? `No cards to post in <b>${categoryLabel}</b>. All active cards in this category have already been posted, or none exist.`
        : 'No cards to post. All active cards have already been posted, or no cards found.',
      { parse_mode: 'HTML' }
    )
  }

  await ctx.reply(
    categorySlug
      ? `📤 Posting ${cards.length} card(s) from <b>${categoryLabel}</b> to the channel...`
      : `📤 Posting ${cards.length} card(s) to the channel...`,
    { parse_mode: 'HTML' }
  )

  let posted = 0
  let failed = 0

  for (const card of cards) {
    try {
      const category = card.category_name ?? card.categories?.name ?? 'Uncategorised'
      const caption =
        `🃏 <b>${card.name}</b>\n` +
        `📂 ${category}\n` +
        `💰 <b>$${Number(card.price).toFixed(2)}</b>\n` +
        `📦 Stock: ${card.quantity}\n\n` +
        `💬 Comment <b>claim</b> or <b>claim [qty]</b> to grab this card!\n` +
        `↩️ Comment <b>unclaim</b> or <b>unclaim [qty]</b> to release.`

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

      // Treat empty/whitespace-only URLs as missing
      const frontImage = card.front_image_url?.trim() || null
      const backImage  = card.back_image_url?.trim()  || null

      let sentMessage

      if (frontImage && backImage) {
        try {
          const mediaGroup = await ctx.telegram.sendMediaGroup(CHANNEL_ID, [
            { type: 'photo', media: frontImage, caption, parse_mode: 'HTML' },
            { type: 'photo', media: backImage },
          ])
          sentMessage = mediaGroup[0]
        } catch (e) {
          // Back image may be broken/unreachable — fall back to front only
          console.log(`media group failed for card ${card.id}, retrying with front image only:`, e.message)
          sentMessage = await ctx.telegram.sendPhoto(CHANNEL_ID, frontImage, {
            caption, parse_mode: 'HTML',
          })
        }
      } else if (frontImage) {
        sentMessage = await ctx.telegram.sendPhoto(CHANNEL_ID, frontImage, {
          caption, parse_mode: 'HTML',
        })
      } else {
        sentMessage = await ctx.telegram.sendMessage(CHANNEL_ID, caption, {
          parse_mode: 'HTML',
        })
      }

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

// ─── Claim ────────────────────────────────────────────────────────────────────

bot.hears(/^claim(\s+\d+)?$/i, async (ctx) => {
  if (!ctx.message?.message_thread_id) return

  const chatId = ctx.message.chat.id
  const replyTo = { reply_parameters: { message_id: ctx.message.message_id } }

  const match = ctx.message.text.trim().match(/^claim\s+(\d+)$/i)
  const requestedQty = match ? parseInt(match[1], 10) : 1

  if (requestedQty < 1) {
    return ctx.telegram.sendMessage(chatId, `❌ Quantity must be at least 1.`, replyTo)
  }

  await upsertUser(ctx.from)

  const post = await getCardByThread(ctx)
  if (!post) return

  const { cards: card } = post
  const userId = ctx.from.id
  const name = ctx.from.first_name ?? ctx.from.username ?? 'User'

  if (!card.is_active) {
    return ctx.telegram.sendMessage(chatId, `❌ This card is no longer available.`, replyTo)
  }

  const { count: totalClaimed } = await supabase
    .from('claims')
    .select('id', { count: 'exact', head: true })
    .eq('card_id', card.id)

  const { count: userClaimed } = await supabase
    .from('claims')
    .select('id', { count: 'exact', head: true })
    .eq('card_id', card.id)
    .eq('telegram_user_id', userId)

  const available = card.quantity - totalClaimed

  if (available <= 0) {
    return ctx.telegram.sendMessage(chatId, `❌ Sorry, all <b>${card.name}</b> have been claimed.`, { parse_mode: 'HTML', ...replyTo })
  }

  if (requestedQty > available) {
    return ctx.telegram.sendMessage(chatId,
      `❌ Only <b>${available}</b> of <b>${card.name}</b> left. You can claim at most ${available}.`,
      { parse_mode: 'HTML', ...replyTo }
    )
  }

  const rows = Array.from({ length: requestedQty }, () => ({
    card_id:          card.id,
    telegram_user_id: userId,
  }))

  const { error } = await supabase.from('claims').insert(rows)
  if (error) return ctx.telegram.sendMessage(chatId, `❌ Could not save claim. Try again.`, replyTo)

  const remaining = available - requestedQty
  const remainingMsg = remaining > 0 ? `\n📦 ${remaining} left!` : `\n📦 Last one(s) taken!`
  const qtyMsg = requestedQty > 1 ? ` x${requestedQty}` : ''

  ctx.telegram.sendMessage(chatId,
    `✅ <b>${card.name}</b>${qtyMsg} claimed by ${name}! 🎉${remainingMsg}\nType /invoice in DM to see your cart.`,
    { parse_mode: 'HTML', ...replyTo }
  )
})

// ─── Unclaim ──────────────────────────────────────────────────────────────────

bot.hears(/^unclaim(\s+\d+)?$/i, async (ctx) => {
  if (!ctx.message?.message_thread_id) return

  const chatId = ctx.message.chat.id
  const replyTo = { reply_parameters: { message_id: ctx.message.message_id } }

  const match = ctx.message.text.trim().match(/^unclaim\s+(\d+)$/i)
  const requestedQty = match ? parseInt(match[1], 10) : 1

  if (requestedQty < 1) {
    return ctx.telegram.sendMessage(chatId, `❌ Quantity must be at least 1.`, replyTo)
  }

  const post = await getCardByThread(ctx)
  if (!post) return

  const { cards: card } = post
  const userId = ctx.from.id

  const { data: userClaims } = await supabase
    .from('claims')
    .select('id')
    .eq('card_id', card.id)
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: true })

  if (!userClaims?.length) {
    return ctx.telegram.sendMessage(chatId, `ℹ️ You haven't claimed <b>${card.name}</b>.`, { parse_mode: 'HTML', ...replyTo })
  }

  if (requestedQty > userClaims.length) {
    return ctx.telegram.sendMessage(chatId,
      `❌ You only have <b>${userClaims.length}</b> claim(s) on <b>${card.name}</b>. You can unclaim at most ${userClaims.length}.`,
      { parse_mode: 'HTML', ...replyTo }
    )
  }

  const idsToDelete = userClaims.slice(0, requestedQty).map(c => c.id)
  await supabase.from('claims').delete().in('id', idsToDelete)

  const qtyMsg = requestedQty > 1 ? ` x${requestedQty}` : ''
  ctx.telegram.sendMessage(chatId, `↩️ Claim on <b>${card.name}</b>${qtyMsg} removed.`, { parse_mode: 'HTML', ...replyTo })
})

// ─── /release ─────────────────────────────────────────────────────────────────

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
  ctx.reply(`↩️ Released all your claims:\n\n${cardNames}`, { parse_mode: 'HTML' })
})

// ─── /invoice ─────────────────────────────────────────────────────────────────

bot.command('invoice', async (ctx) => {
  await upsertUser(ctx.from)
  const userId = ctx.from.id

  const { data: claims, error } = await supabase
    .from('claims')
    .select('id, cards(id, name, price)')
    .eq('telegram_user_id', userId)

  if (error) return ctx.telegram.sendMessage(userId, '❌ Could not fetch your claims. Try again.')

  if (!claims?.length) {
    return ctx.telegram.sendMessage(userId,
      "🛒 You haven't claimed any cards yet.\n\nComment <b>claim</b> under a card listing to grab one.",
      { parse_mode: 'HTML' }
    )
  }

  const { lines, total } = buildInvoiceSummary(claims)

  const msg =
    `🧾 <b>Your Invoice</b>\n\n` +
    `${lines}\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `<b>Total: $${total.toFixed(2)}</b>\n\n` +
    `Paynow to UEN <code>T26LL0533A</code> with your telegram username in the reference! Send your payment screenshot directly to this bot and we'll verify it shortly.`

  await ctx.telegram.sendPhoto(userId, PAYNOW_QR, {
    caption: msg,
    parse_mode: 'HTML',
  })

  if (ctx.chat.type !== 'private') {
    ctx.reply(`📩 Invoice sent to your DM, ${ctx.from.first_name}!`)
  }
})

// ─── Helper: show collection method menu ─────────────────────────────────────

async function showCollectionMenu(ctx) {
  return ctx.reply(
    `Please select your preferred collection method:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 Self Collect', 'collect_self')],
        [Markup.button.callback('🛍️ TikTok Polymailer', 'collect_tiktok')],
        [Markup.button.callback('📮 SingPost Polymailer (+$4)', 'collect_singpost')],
      ])
    }
  )
}

// ─── Collection method: Self Collect ─────────────────────────────────────────

bot.action('collect_self', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined)
  ctx.reply(
    `Please confirm your option for Self Collection ⚠️\n\n` +
    `Do follow the instructions and arrange for self collection inside here ⬇️\n` +
    `https://t.me/allthingstcg/3946`,
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm', 'confirm_self')],
        [Markup.button.callback('↩️ Go Back', 'go_back')],
      ])
    }
  )
})

bot.action('confirm_self', async (ctx) => {
  await ctx.answerCbQuery()
  const userId = ctx.from.id
  await notifyAdmins(ctx, userId, 'self_collect', 0)
  await ctx.editMessageReplyMarkup(undefined)
  ctx.reply(`Your collection method has been confirmed! ✅\n\n<i>PM @allthingstcgadmin for any further inquiries</i> 💬\n\n<b>Thank you for your support!</b> 🙇🏻‍♂️`, { parse_mode: 'HTML' })
})

// ─── Collection method: TikTok Polymailer ────────────────────────────────────

bot.action('collect_tiktok', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined)
  ctx.reply(
    `Please confirm your option for Tiktok Polymailer ⚠️\n\n` +
    `Order the Tiktok Polymailer under "Re:Born" below and the items will be shipped to your registered address in Tiktok! ⬇️\n` +
    `https://vt.tiktok.com/ZS92aPRb2F33S-clqGk/\n\n` +
    `PM @allthingstcgadmin if the link does not work! ⛓️‍💥`,
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm', 'confirm_tiktok')],
        [Markup.button.callback('↩️ Go Back', 'go_back')],
      ])
    }
  )
})

bot.action('confirm_tiktok', async (ctx) => {
  await ctx.answerCbQuery()
  const userId = ctx.from.id
  await notifyAdmins(ctx, userId, 'tiktok_polymailer', 0)
  await ctx.editMessageReplyMarkup(undefined)
  ctx.reply(`Your collection method has been confirmed! ✅\n\n<i>PM @allthingstcgadmin for any further inquiries</i> 💬\n\n<b>Thank you for your support!</b> 🙇🏻‍♂️`, { parse_mode: 'HTML' })
})

// ─── Collection method: SingPost Polymailer ──────────────────────────────────

bot.action('collect_singpost', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined)
  await ctx.replyWithPhoto(PAYNOW_QR, {
    caption:
      `Please confirm your option for Singpost Polymailer ⚠️\n\n` +
      `Do paynow $4 to UEN <code>T26LL0533A</code> with your telegram username in the reference!`,
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', 'confirm_singpost')],
      [Markup.button.callback('↩️ Go Back', 'go_back')],
    ])
  })
})

bot.action('confirm_singpost', async (ctx) => {
  await ctx.answerCbQuery()
  const userId = ctx.from.id
  await ctx.editMessageReplyMarkup(undefined)
  ctx.reply(
    `📮 <b>SingPost Polymailer (+$4)</b>\n\n` +
    `Please send your payment screenshot here and I'll collect your delivery details.`,
    { parse_mode: 'HTML' }
  )
  pendingAddress.set(userId, { step: 'awaiting_shipping_screenshot' })
})

// ─── Go Back ──────────────────────────────────────────────────────────────────

bot.action('go_back', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined)
  await showCollectionMenu(ctx)
})

// ─── notifyAdmins ─────────────────────────────────────────────────────────────

async function notifyAdmins(ctx, userId, collectionMethod, shippingFee, shippingDetails = null) {
  const { data: claims } = await supabase
    .from('claims')
    .select('cards(name, price)')
    .eq('telegram_user_id', userId)

  const { data: user } = await supabase
    .from('users')
    .select('first_name, username, pending_screenshot')
    .eq('telegram_user_id', userId)
    .single()

  const name = user?.first_name ?? 'Unknown'
  const username = user?.username ? `@${user.username}` : `ID: ${userId}`
  const photoFileId = user?.pending_screenshot

  const itemTotal = (claims ?? []).reduce((sum, c) => sum + Number(c.cards.price), 0)
  const grandTotal = itemTotal + shippingFee

  const grouped = {}
  for (const c of (claims ?? [])) {
    const key = c.cards.name
    if (!grouped[key]) grouped[key] = { price: Number(c.cards.price), qty: 0 }
    grouped[key].qty++
  }
  const itemList = Object.entries(grouped)
    .map(([name, v]) => `• ${name} x${v.qty} — $${(v.price * v.qty).toFixed(2)}`)
    .join('\n')

  const methodLabel = {
    self_collect:      '📦 Self Collect',
    tiktok_polymailer: '🛍️ TikTok Polymailer',
    singpost_mailing:  '📮 SingPost Polymailer',
  }[collectionMethod] ?? collectionMethod

  const updatePayload = {
    pending_collection_method: collectionMethod,
    pending_shipping_fee:      shippingFee,
    pending_screenshot:        null,
  }
  if (shippingDetails) {
    updatePayload.pending_recipient_name    = shippingDetails.name
    updatePayload.pending_recipient_contact = shippingDetails.contact
    updatePayload.pending_recipient_address = shippingDetails.address
    updatePayload.pending_recipient_postal  = shippingDetails.postal
  }
  await supabase.from('users').update(updatePayload).eq('telegram_user_id', userId)

  let adminCaption =
    `💳 <b>Payment Received</b>\n\n` +
    `👤 <b>User:</b> ${name} (${username})\n` +
    `🆔 <b>User ID:</b> <code>${userId}</code>\n\n` +
    `🛒 <b>Items:</b>\n${itemList}\n\n` +
    `🚚 <b>Collection:</b> ${methodLabel}\n`

  if (shippingFee > 0) adminCaption += `📦 <b>Shipping Fee:</b> $${shippingFee.toFixed(2)}\n`

  adminCaption += `\n━━━━━━━━━━━━━━\n<b>Grand Total: $${grandTotal.toFixed(2)}</b>`

  if (shippingDetails) {
    adminCaption +=
      `\n\n📋 <b>Delivery Details:</b>\n` +
      `Name: ${shippingDetails.name}\n` +
      `Contact: ${shippingDetails.contact}\n` +
      `Address: ${shippingDetails.address}\n` +
      `Postal: ${shippingDetails.postal}`
  }

  adminCaption += `\n\nTo confirm payment:\n<code>/markpaid ${userId}</code>`

  // ── Send to admin group instead of individual admins ──
  try {
    if (photoFileId) {
      await ctx.telegram.sendPhoto(ADMIN_GROUP_ID, photoFileId, { caption: adminCaption, parse_mode: 'HTML' })
    } else {
      await ctx.telegram.sendMessage(ADMIN_GROUP_ID, adminCaption, { parse_mode: 'HTML' })
    }
    if (shippingDetails?.shippingScreenshot) {
      await ctx.telegram.sendPhoto(ADMIN_GROUP_ID, shippingDetails.shippingScreenshot, {
        caption: `📮 Shipping payment screenshot for ${username}`,
      })
    }
  } catch (e) {
    console.log(`Could not notify admin group:`, e.message)
  }
}

// ─── /markpaid ────────────────────────────────────────────────────────────────

bot.command('markpaid', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Admins only.')

  const targetId = Number(ctx.message.text.split(' ')[1])
  if (!targetId) return ctx.reply('Usage: /markpaid <telegram_user_id>')

  const { data: claims } = await supabase
    .from('claims')
    .select('id, cards(id, name, price)')
    .eq('telegram_user_id', targetId)

  if (!claims?.length) return ctx.reply(`No active claims found for user ${targetId}.`)

  const { data: user } = await supabase
    .from('users')
    .select('first_name, pending_collection_method, pending_shipping_fee, pending_recipient_name, pending_recipient_contact, pending_recipient_address, pending_recipient_postal')
    .eq('telegram_user_id', targetId)
    .single()

  const collectionMethod = user?.pending_collection_method ?? 'unknown'
  const shippingFee      = Number(user?.pending_shipping_fee ?? 0)
  const itemTotal        = claims.reduce((sum, c) => sum + Number(c.cards.price), 0)
  const grandTotal       = itemTotal + shippingFee

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      telegram_user_id:  targetId,
      status:            'paid',
      total_amount:      grandTotal,
      shipping_fee:      shippingFee,
      collection_method: collectionMethod,
      recipient_name:    user?.pending_recipient_name    ?? null,
      recipient_contact: user?.pending_recipient_contact ?? null,
      recipient_address: user?.pending_recipient_address ?? null,
      recipient_postal:  user?.pending_recipient_postal  ?? null,
      paid_at:           new Date().toISOString(),
    })
    .select()
    .single()

  if (orderError) return ctx.reply(`❌ Error creating order: ${orderError.message}`)

  for (const claim of claims) {
    await supabase.from('order_items').insert({
      order_id:   order.id,
      card_id:    claim.cards.id,
      quantity:   1,
      unit_price: claim.cards.price,
    })
    await supabase.rpc('decrement_quantity', { card_id: claim.cards.id })
  }

  await supabase.from('claims').delete().eq('telegram_user_id', targetId)

  await supabase.from('users').update({
    pending_collection_method:  null,
    pending_shipping_fee:       null,
    pending_recipient_name:     null,
    pending_recipient_contact:  null,
    pending_recipient_address:  null,
    pending_recipient_postal:   null,
  }).eq('telegram_user_id', targetId)

  const grouped = {}
  for (const c of claims) {
    const key = c.cards.name
    if (!grouped[key]) grouped[key] = { price: Number(c.cards.price), qty: 0 }
    grouped[key].qty++
  }
  const itemList = Object.entries(grouped)
    .map(([name, v]) => `• ${name} x${v.qty} — $${(v.price * v.qty).toFixed(2)}`)
    .join('\n')

  const methodLabel = {
    self_collect:      '📦 Self Collect',
    tiktok_polymailer: '🛍️ TikTok Polymailer',
    singpost_mailing:  '📮 SingPost Polymailer',
  }[collectionMethod] ?? collectionMethod

  let confirmMsg =
    `✅ <b>Payment Confirmed! Thank you!</b>\n\n` +
    `<b>Order ID:</b> <code>${order.id}</code>\n\n` +
    `🛒 <b>Items:</b>\n${itemList}\n`

  if (shippingFee > 0) confirmMsg += `📦 <b>Shipping:</b> $${shippingFee.toFixed(2)}\n`

  confirmMsg += `\n━━━━━━━━━━━━━━\n<b>Total Paid: $${grandTotal.toFixed(2)}</b>\n\n🚚 <b>Collection Method:</b> ${methodLabel}\n\n`

  confirmMsg += `Your collection method has been confirmed! ✅\n\n<i>PM @allthingstcgadmin for any further inquiries</i> 💬\n\n<b>Thank you for your support!</b> 🙇🏻‍♂️`

  await ctx.telegram.sendMessage(targetId, confirmMsg, { parse_mode: 'HTML' })
  ctx.reply(`✅ Order confirmed. User notified. Order ID: <code>${order.id}</code>`, { parse_mode: 'HTML' })
})

// ─── /claims (admin) ──────────────────────────────────────────────────────────

bot.command('claims', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Admins only.')

  const { data, error } = await supabase
    .from('claims')
    .select('telegram_user_id, users(first_name, username), cards(name, price)')
    .order('created_at', { ascending: true })

  if (error) return ctx.reply(`❌ ${error.message}`)
  if (!data?.length) return ctx.reply('No active claims.')

  const byUser = {}
  for (const c of data) {
    const uid = c.telegram_user_id
    if (!byUser[uid]) {
      byUser[uid] = {
        label: c.users?.username ? `@${c.users.username}` : c.users?.first_name ?? uid,
        cards: {}
      }
    }
    const cardName = c.cards.name
    byUser[uid].cards[cardName] = (byUser[uid].cards[cardName] ?? 0) + 1
  }

  const lines = Object.values(byUser).map(u => {
    const cardList = Object.entries(u.cards).map(([n, q]) => `  • ${n} x${q}`).join('\n')
    return `👤 ${u.label}\n${cardList}`
  }).join('\n\n')

  ctx.reply(`📋 <b>Active Claims</b>\n\n${lines}`, { parse_mode: 'HTML' })
})

// ─── Unified message handler ──────────────────────────────────────────────────

bot.on('message', async (ctx) => {
  const msg = ctx.message

  // 1. Forward listener
  const fwd = msg?.forward_from_chat
  if (fwd && fwd.id.toString() === CHANNEL_ID.toString()) {
    const originalChannelMessageId = msg?.forward_from_message_id
    const groupThreadMessageId     = msg?.message_id

    if (originalChannelMessageId && groupThreadMessageId) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const { data } = await supabase
          .from('discussion_posts')
          .update({ telegram_message_id: groupThreadMessageId })
          .eq('telegram_message_id', originalChannelMessageId)
          .select()

        if (data?.length) {
          console.log(`updated thread id: ${originalChannelMessageId} → ${groupThreadMessageId} (attempt ${attempt})`)
          return
        }
        console.log(`attempt ${attempt}: row not found yet, retrying...`)
        await new Promise(r => setTimeout(r, 500))
      }
      console.log(`failed to update thread id after 5 attempts`)
    }
    return
  }

  if (ctx.chat.type !== 'private') return

  const userId = ctx.from.id
  const state  = pendingAddress.get(userId)

  // 2. SingPost shipping screenshot
  if (msg.photo && state?.step === 'awaiting_shipping_screenshot') {
    const shippingScreenshot = msg.photo.at(-1).file_id
    pendingAddress.set(userId, { ...state, step: 'awaiting_name', shippingScreenshot })
    return ctx.reply(
      `✅ Shipping payment screenshot received!\n\nNow I need your delivery details. Please enter your <b>full name</b>:`,
      { parse_mode: 'HTML' }
    )
  }

  // 3. Main payment screenshot
  if (msg.photo && !state) {
    await upsertUser(ctx.from)

    const { data: claims } = await supabase
      .from('claims')
      .select('cards(name, price)')
      .eq('telegram_user_id', userId)

    if (!claims?.length) {
      return ctx.reply(
        "⚠️ You don't have any active claims. Please comment <b>claim</b> on a card first before sending payment.",
        { parse_mode: 'HTML' }
      )
    }

    const photoFileId = msg.photo.at(-1).file_id
    await supabase.from('users').update({ pending_screenshot: photoFileId }).eq('telegram_user_id', userId)

    const { lines, total } = buildInvoiceSummary(claims)

    await ctx.reply(
      `✅ Screenshot received!\n\n` +
      `🧾 <b>Your order:</b>\n${lines}\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `<b>Total: $${total.toFixed(2)}</b>`,
      { parse_mode: 'HTML' }
    )
    return showCollectionMenu(ctx)
  }

  // 4. Address collection steps
  if (msg.text && state) {
    const text = msg.text.trim()

    if (state.step === 'awaiting_name') {
      pendingAddress.set(userId, { ...state, step: 'awaiting_contact', name: text })
      return ctx.reply('📞 Please enter your <b>contact number</b>:', { parse_mode: 'HTML' })
    }
    if (state.step === 'awaiting_contact') {
      pendingAddress.set(userId, { ...state, step: 'awaiting_address', contact: text })
      return ctx.reply('🏠 Please enter your <b>address</b> (block/street/unit):', { parse_mode: 'HTML' })
    }
    if (state.step === 'awaiting_address') {
      pendingAddress.set(userId, { ...state, step: 'awaiting_postal', address: text })
      return ctx.reply('📮 Please enter your <b>postal code</b>:', { parse_mode: 'HTML' })
    }
    if (state.step === 'awaiting_postal') {
      const { name, contact, address, shippingScreenshot } = state
      const postal = text
      pendingAddress.delete(userId)

      await notifyAdmins(ctx, userId, 'singpost_mailing', 4, {
        name, contact, address, postal, shippingScreenshot,
      })

      return ctx.reply(`Your collection method has been confirmed! ✅\n\n<i>PM @allthingstcgadmin for any further inquiries</i> 💬\n\n<b>Thank you for your support!</b> 🙇🏻‍♂️`, { parse_mode: 'HTML' })
    }
  }
})

// ─── Launch ───────────────────────────────────────────────────────────────────

if (process.env.ENV === 'dev') {
  bot.launch()
  console.log('🤖 Bot is running...')
}

process.once('SIGINT',  () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

export default bot