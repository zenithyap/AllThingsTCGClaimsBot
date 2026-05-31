import bot from "../bot/index.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    await bot.handleUpdate(req.body);
    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
};