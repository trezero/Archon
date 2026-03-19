# Telegram Setup

Connect Archon to Telegram so you can interact with your AI coding assistant from any Telegram client.

## Prerequisites

- Archon server running (see [Getting Started](../getting-started.md))
- A Telegram account

## Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## Set Environment Variable

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
```

## Configure Streaming Mode (Optional)

```env
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

For streaming mode details, see [Advanced Configuration](../configuration.md).

## Further Reading

- [Advanced Configuration](../configuration.md)
