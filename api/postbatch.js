import { waitUntil } from "@vercel/functions";
import { runPostcardsBatch } from "../bot/postcards.js";

// Internal endpoint used by runPostcardsBatch to chain batches across
// invocations. Protected by a shared secret (the bot token).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  if (req.headers["x-internal-secret"] !== process.env.BOT_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  const { categorySlug, page, reportChatId, totals } = req.body ?? {};
  if (!page || !reportChatId) return res.status(400).send("Bad Request");

  // Ack immediately so the previous batch's invocation can exit,
  // then run this batch in the background.
  waitUntil(
    runPostcardsBatch({ categorySlug, page, reportChatId, totals }).catch((err) => {
      console.error("postbatch error:", err);
    })
  );

  res.status(200).send("OK");
}
