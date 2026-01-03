import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { config } from 'dotenv';

config();

// Logging utility with timestamps
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = {
    INFO: '📋',
    DEBUG: '🔍',
    WARN: '⚠️',
    ERROR: '❌',
    SUCCESS: '✅',
    PROCESS: '⚙️',
    DISCORD: '💬',
    CLAUDE: '🤖',
  }[level] || '•';

  const logMessage = `[${timestamp}] ${prefix} [${level}] ${message}`;

  if (data) {
    console.log(logMessage, JSON.stringify(data, null, 2));
  } else {
    console.log(logMessage);
  }
}

log('INFO', 'Bot starting up...');
log('DEBUG', 'Loading environment variables');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

log('DEBUG', 'Discord client created with intents', {
  intents: ['Guilds', 'GuildMessages', 'DirectMessages', 'MessageContent'],
  partials: ['Channel', 'Message'],
});

// Default working directory if none specified
const DEFAULT_DIR = process.env.DEFAULT_DIR || process.cwd();
log('INFO', `Default directory set to: ${DEFAULT_DIR}`);

// Track active sessions to prevent spam
const activeSessions = new Map();

/**
 * Parse message to extract directory and task
 * Format: "/path/to/project: task description" or just "task description"
 */
function parseMessage(content) {
  log('DEBUG', 'Parsing message content', { content: content.substring(0, 100) });

  const colonMatch = content.match(/^([^:]+):\s*(.+)$/s);

  if (colonMatch) {
    const potentialPath = colonMatch[1].trim();
    log('DEBUG', `Found colon separator, checking if path: "${potentialPath}"`);

    // Check if it looks like a path (starts with / or ~)
    if (potentialPath.startsWith('/') || potentialPath.startsWith('~')) {
      const expandedPath = potentialPath.replace(/^~/, process.env.HOME);
      log('DEBUG', `Expanded path: ${expandedPath}`);

      if (existsSync(expandedPath)) {
        log('SUCCESS', `Valid directory found: ${expandedPath}`);
        return {
          directory: expandedPath,
          task: colonMatch[2].trim(),
        };
      } else {
        log('WARN', `Path does not exist: ${expandedPath}`);
      }
    }
  }

  // No valid path found, use default directory
  log('DEBUG', 'No custom path found, using default directory');
  return {
    directory: DEFAULT_DIR,
    task: content.trim(),
  };
}

/**
 * Spawn Claude Code and stream output back to Discord
 */
async function runClaudeCode(message, directory, task) {
  const sessionId = `${message.channel.id}-${message.author.id}`;
  log('CLAUDE', `Starting new session`, {
    sessionId,
    user: message.author.tag,
    userId: message.author.id,
    channel: message.channel.id,
    directory,
    task: task.substring(0, 100) + (task.length > 100 ? '...' : ''),
  });

  // Check for existing session
  if (activeSessions.has(sessionId)) {
    log('WARN', `User ${message.author.tag} already has active session: ${sessionId}`);
    await message.reply('⚠️ You already have an active Claude Code session. Please wait for it to complete.');
    return;
  }

  // Send initial acknowledgment
  log('DISCORD', 'Sending initial acknowledgment to Discord');
  const statusMessage = await message.reply(
    `🚀 Starting Claude Code session...\n📁 Directory: \`${directory}\`\n📝 Task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`
  );
  log('SUCCESS', 'Acknowledgment sent');

  // Spawn Claude Code process
  // Use shell command string to properly handle the task with quotes
  // --dangerously-skip-permissions is needed for non-interactive use
  const escapedTask = task.replace(/'/g, "'\\''"); // Escape single quotes for shell
  const fullCommand = `claude -p --dangerously-skip-permissions '${escapedTask}'`;
  log('PROCESS', `Spawning Claude Code process`, {
    fullCommand,
    cwd: directory,
  });

  const claudeProcess = spawn(fullCommand, [], {
    cwd: directory,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'], // Explicitly pipe stdout/stderr
    env: { ...process.env, CLAUDE_DISABLE_INTERACTIVITY: '1' },
  });

  log('PROCESS', `Process spawned with PID: ${claudeProcess.pid}`);
  log('DEBUG', `stdout exists: ${!!claudeProcess.stdout}, stderr exists: ${!!claudeProcess.stderr}`);
  activeSessions.set(sessionId, claudeProcess);
  log('DEBUG', `Active sessions count: ${activeSessions.size}`);

  let outputBuffer = '';
  let lastUpdateTime = Date.now();
  const UPDATE_INTERVAL = 2000; // Update every 2 seconds
  const MAX_MESSAGE_LENGTH = 1900; // Discord limit is 2000, leave room for formatting

  const updateStatus = async (content, isFinal = false) => {
    try {
      // Truncate content if too long
      let displayContent = content;
      if (content.length > MAX_MESSAGE_LENGTH) {
        displayContent = '...' + content.slice(-MAX_MESSAGE_LENGTH);
        log('DEBUG', `Output truncated from ${content.length} to ${displayContent.length} chars`);
      }

      const prefix = isFinal ? '✅ **Completed**' : '⏳ **Working**';
      const formattedContent = `${prefix}\n📁 \`${directory}\`\n\n\`\`\`\n${displayContent}\n\`\`\``;

      log('DISCORD', `Updating status message (final: ${isFinal})`, {
        contentLength: displayContent.length,
      });
      await statusMessage.edit(formattedContent.slice(0, 2000));
    } catch (err) {
      log('ERROR', `Failed to update Discord message: ${err.message}`);
    }
  };

  claudeProcess.stdout.on('data', (data) => {
    const chunk = data.toString();
    outputBuffer += chunk;
    log('CLAUDE', `[stdout] Received ${chunk.length} bytes`, {
      preview: chunk.substring(0, 200) + (chunk.length > 200 ? '...' : ''),
      totalBufferSize: outputBuffer.length,
    });

    // Rate limit updates
    const now = Date.now();
    if (now - lastUpdateTime > UPDATE_INTERVAL) {
      log('DEBUG', 'Rate limit passed, updating Discord status');
      lastUpdateTime = now;
      updateStatus(outputBuffer);
    }
  });

  claudeProcess.stderr.on('data', (data) => {
    const chunk = data.toString();
    log('CLAUDE', `[stderr] ${chunk}`);
    outputBuffer += `[stderr] ${chunk}`;
  });

  claudeProcess.on('close', async (code) => {
    log('PROCESS', `Claude Code process exited`, {
      pid: claudeProcess.pid,
      exitCode: code,
      sessionId,
      totalOutput: outputBuffer.length,
    });

    activeSessions.delete(sessionId);
    log('DEBUG', `Session removed. Active sessions: ${activeSessions.size}`);

    if (code === 0) {
      log('SUCCESS', 'Task completed successfully');
      await updateStatus(outputBuffer || 'Task completed successfully (no output)', true);
    } else {
      log('ERROR', `Task failed with exit code ${code}`);
      try {
        await statusMessage.edit(
          `❌ **Failed** (exit code: ${code})\n📁 \`${directory}\`\n\n\`\`\`\n${outputBuffer.slice(-1500) || 'No output'}\n\`\`\``
        );
      } catch (err) {
        log('ERROR', `Failed to update final message: ${err.message}`);
      }
    }
  });

  claudeProcess.on('error', async (err) => {
    log('ERROR', `Failed to spawn Claude Code process`, {
      error: err.message,
      sessionId,
    });

    activeSessions.delete(sessionId);
    try {
      await statusMessage.edit(`❌ **Error spawning Claude Code**\n\`\`\`\n${err.message}\n\`\`\``);
    } catch (updateErr) {
      log('ERROR', `Failed to update error message: ${updateErr.message}`);
    }
  });
}

client.on('clientReady', () => {
  log('SUCCESS', `Logged in as ${client.user.tag}`);
  log('INFO', `Bot ID: ${client.user.id}`);
  log('INFO', `Default directory: ${DEFAULT_DIR}`);
  log('INFO', 'Listening for direct messages and mentions...');
  log('INFO', '='.repeat(50));
});

client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) {
    log('DEBUG', `Ignoring bot message from ${message.author.tag}`);
    return;
  }

  // Only respond to DMs or mentions
  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user);

  log('DISCORD', 'Message received', {
    author: message.author.tag,
    authorId: message.author.id,
    isDM,
    isMentioned,
    guild: message.guild?.name || 'DM',
    channel: message.channel.id,
    contentPreview: message.content.substring(0, 50) + (message.content.length > 50 ? '...' : ''),
  });

  if (!isDM && !isMentioned) {
    log('DEBUG', 'Message ignored - not a DM and bot not mentioned');
    return;
  }

  log('INFO', `Processing message from ${message.author.tag}`);

  // Remove bot mention from content if present
  let content = message.content.replace(/<@!?\d+>/g, '').trim();
  log('DEBUG', `Cleaned content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);

  if (!content) {
    log('INFO', 'Empty message received, sending help text');
    await message.reply(
      '👋 Send me a task to work on!\n\n' +
      '**Format:**\n' +
      '• Just send a task: `fix the login bug`\n' +
      '• With specific directory: `/path/to/project: fix the login bug`\n\n' +
      `Default directory: \`${DEFAULT_DIR}\``
    );
    return;
  }

  const { directory, task } = parseMessage(content);
  log('INFO', 'Message parsed', { directory, task: task.substring(0, 100) });

  // Validate directory exists
  if (!existsSync(directory)) {
    log('ERROR', `Directory not found: ${directory}`);
    await message.reply(`❌ Directory not found: \`${directory}\``);
    return;
  }

  log('SUCCESS', `Directory validated: ${directory}`);
  await runClaudeCode(message, directory, task);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('WARN', 'Received SIGINT signal, shutting down...');
  log('INFO', `Killing ${activeSessions.size} active sessions`);

  // Kill all active Claude processes
  for (const [sessionId, proc] of activeSessions) {
    log('PROCESS', `Killing process for session: ${sessionId}`);
    proc.kill('SIGTERM');
  }

  log('INFO', 'Destroying Discord client');
  client.destroy();
  log('SUCCESS', 'Shutdown complete');
  process.exit(0);
});

// Start the bot
const token = process.env.DISCORD_TOKEN;
if (!token) {
  log('ERROR', 'DISCORD_TOKEN environment variable is required');
  log('INFO', 'Create a .env file with: DISCORD_TOKEN=your_token_here');
  process.exit(1);
}

log('INFO', 'Connecting to Discord...');
client.login(token);
