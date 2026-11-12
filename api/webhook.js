import { waitUntil } from "@vercel/functions";
import bot from "../bot/index.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  // Ack Telegram immediately so it never redelivers this update,
  // then finish processing (e.g. the /postcards loop) in the background.
  waitUntil(
    bot.handleUpdate(req.body).catch((err) => {
      console.error("handleUpdate error:", err);
    })
  );

  res.status(200).send("OK");
}
