# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
This project is a Discord bot that acts as a bridge to `claude-code`. It allows users to issue commands via Discord which are then executed by a spawned `claude` process on the host machine. The output is streamed back to Discord.

- **Main Entry Point**: `bot.js`
- **Language**: Node.js (ES Modules)
- **Key Dependencies**: `discord.js` (Discord interaction), `dotenv` (Configuration)

## Build and Run
- **Install Dependencies**: `npm install`
- **Start Bot**: `npm start` (Runs `node bot.js`)
- **Lint/Test**: No linting or testing scripts are currently configured in `package.json`.

## Architecture & Logic
- **`bot.js`**: Contains the entire logic.
  - **`log()`**: Custom logging with timestamps and emojis.
  - **`parseMessage()`**: Extracts target directory and task from user input. format: `[path]: [task]`.
  - **`runClaudeCode()`**: Spawns the `claude` child process.
    - Uses `--dangerously-skip-permissions` to run non-interactively.
    - Pipes `stdout` and `stderr` and buffers them.
    - Updates a Discord message every 2 seconds (`UPDATE_INTERVAL`) to avoid rate limits.
    - Handles process exit and final status update.
  - **`activeSessions`**: A Map tracking running processes to prevent concurrent sessions per user/channel.

## Development Notes
- The bot requires `DISCORD_TOKEN` in `.env`.
- It expects the `claude` CLI to be available in the system PATH.
- Security: The bot executes shell commands. Ensure the host environment is secure and the bot token is kept private.
- The `spawn` command uses `shell: true` and manually escapes single quotes in the task string.
