# Arcade Telegram bot

This repo is a companion to the [YouTube video](https://www.youtube.com/@TryArcade) about simplifying the integration of agents into any communication channel.

# Credits

## Features

- Authenticate with your Google Calendar via OAuth2.
- Extract event details (title, start/end time, description) from natural language.
- Support for multiple Google accounts and calendars.
- Support for multiple timezones.
- Enable or disable specific calendars for event insertion.
- Integrated Express server to handle OAuth callbacks.

## Getting Started

1. Clone the repository.
2. Install dependencies:
   npm install
3. Set the required environment variables:
   - GROQ_API_KEY
   - TELEGRAM_BOT_TOKEN
   - ARCADE_API_KEY
   - Optionally: DEFAULT_TIMEZONE
4. Run the project:
   npm start

### Getting API keys

- Groq API key: https://console.groq.com/keys
- Telegram bot token: https://core.telegram.org/bots/tutorial#obtain-your-bot-token
- Arcade API key: https://arcade.dev

Once running, use Telegram to interact with the bot:
- Use /auth to connect a Google account.
- Send an event description to propose a new calendar event.
- Use /confirm to add the event(s) to your calendar.
- Use /edit to modify an event before confirming.

Enjoy managing your calendar with ease!

