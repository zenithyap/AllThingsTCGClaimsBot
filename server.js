import express from "express";
import bot from "./bot/index.js";

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  await bot.handleUpdate(req.body);
  res.send("OK");
});

app.listen(3000, () => {
  console.log("Local bot running on http://localhost:3000");
});