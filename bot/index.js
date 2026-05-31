dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

if (process.env.ENV === "dev") {
  bot.launch(); // Removed for Vercel serverless compatibility - using webhooks instead
}
export default bot;