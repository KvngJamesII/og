const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const fs = require('fs');

class BotManager {
  constructor(db) {
    this.db = db;
    this.bots = new Map(); // botId -> bot instance data
  }

  async startBot(botId) {
    try {
      // Check if bot is already running
      if (this.bots.has(botId)) {
        return { success: false, error: 'Bot is already running' };
      }

      // Get bot config from database
      const config = await this.getBotConfig(botId);
      if (!config) {
        return { success: false, error: 'Bot configuration not found' };
      }

      // Create bot instance
      const botInstance = {
        id: botId,
        config,
        telegramBot: null,
        browser: null,
        page: null,
        sentMessageHashes: new Set(),
        pollInterval: null,
        healthCheckInterval: null,
        isPolling: false,
        pollCount: 0,
        lastSuccessfulPoll: Date.now(),
        messagesFile: `./data/bot-${botId}-messages.json`,
        otpsSentCount: 0 // Track number of OTPs sent
      };

      // Load previous messages
      this.loadSentMessages(botInstance);

      // Initialize Telegram bot
      botInstance.telegramBot = new TelegramBot(config.telegram_bot_token, { polling: true });
      
      this.setupTelegramHandlers(botInstance);

      // Initialize browser
      const browserInitialized = await this.initializeBrowser(botInstance);
      if (!browserInitialized) {
        return { success: false, error: 'Failed to initialize browser' };
      }

      // Mark existing messages as sent
      await this.markExistingMessagesAsSent(botInstance);

      // Start polling
      this.startPolling(botInstance);

      // Store bot instance
      this.bots.set(botId, botInstance);

      // Send connection message
      await this.sendConnectionMessage(botInstance);

      this.log(botId, 'info', `Bot started successfully for user: ${config.user_name}`);
      
      return { success: true };
    } catch (err) {
      this.log(botId, 'error', `Failed to start bot: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  stopBot(botId) {
    const botInstance = this.bots.get(botId);
    if (!botInstance) {
      return false;
    }

    try {
      // Save messages
      this.saveSentMessages(botInstance);

      // Stop polling
      if (botInstance.pollInterval) {
        clearInterval(botInstance.pollInterval);
      }
      if (botInstance.healthCheckInterval) {
        clearInterval(botInstance.healthCheckInterval);
      }

      // Stop Telegram bot
      if (botInstance.telegramBot) {
        botInstance.telegramBot.stopPolling();
      }

      // Close browser
      if (botInstance.browser) {
        botInstance.browser.close().catch(() => {});
      }

      // Remove from map
      this.bots.delete(botId);

      this.log(botId, 'info', 'Bot stopped successfully');
      return true;
    } catch (err) {
      this.log(botId, 'error', `Error stopping bot: ${err.message}`);
      return false;
    }
  }

  async stopAllBots() {
    const botIds = Array.from(this.bots.keys());
    for (const botId of botIds) {
      this.stopBot(botId);
    }
  }

  isRunning(botId) {
    return this.bots.has(botId);
  }

  getRunningBotsCount() {
    return this.bots.size;
  }

  getStats(botId) {
    const botInstance = this.bots.get(botId);
    if (!botInstance) {
      return null;
    }

    const timeSinceLastPoll = Date.now() - botInstance.lastSuccessfulPoll;
    
    return {
      pollCount: botInstance.pollCount,
      messagesTracked: botInstance.sentMessageHashes.size,
      browserActive: !!botInstance.browser,
      lastSuccessfulPoll: new Date(botInstance.lastSuccessfulPoll).toISOString(),
      timeSinceLastPoll: `${Math.floor(timeSinceLastPoll / 1000)}s`
    };
  }

  async getBotConfig(botId) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM bot_configs WHERE id = ?', [botId], (err, row) => {
        if (err) reject(err);
        else if (!row) resolve(null);
        else {
          row.telegram_chat_ids = JSON.parse(row.telegram_chat_ids);
          resolve(row);
        }
      });
    });
  }

  loadSentMessages(botInstance) {
    try {
      if (!fs.existsSync('./data')) {
        fs.mkdirSync('./data');
      }
      
      if (fs.existsSync(botInstance.messagesFile)) {
        const data = fs.readFileSync(botInstance.messagesFile, 'utf8');
        const hashes = JSON.parse(data);
        botInstance.sentMessageHashes = new Set(hashes);
        console.log(`📂 [${botInstance.id}] Loaded ${botInstance.sentMessageHashes.size} message hashes`);
      }
    } catch (err) {
      console.error(`⚠️ [${botInstance.id}] Could not load messages:`, err.message);
    }
  }

  saveSentMessages(botInstance) {
    try {
      if (!fs.existsSync('./data')) {
        fs.mkdirSync('./data');
      }
      
      const hashArray = Array.from(botInstance.sentMessageHashes).slice(-1000);
      fs.writeFileSync(botInstance.messagesFile, JSON.stringify(hashArray, null, 2));
    } catch (err) {
      console.error(`⚠️ [${botInstance.id}] Could not save messages:`, err.message);
    }
  }

  async initializeBrowser(botInstance) {
    try {
      console.log(`🌐 [${botInstance.id}] Initializing browser...`);

      botInstance.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled'
        ]
      });

      botInstance.page = await botInstance.browser.newPage();
      await botInstance.page.setViewport({ width: 1920, height: 1080 });
      await botInstance.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

      // Login
      await botInstance.page.goto(botInstance.config.login_url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 2000));

      const captchaAnswer = await this.solveMathCaptcha(botInstance.page);
      if (!captchaAnswer) {
        throw new Error('Could not solve captcha');
      }

      await botInstance.page.waitForSelector('input[name="username"]', { timeout: 5000 });
      await botInstance.page.type('input[name="username"]', botInstance.config.panel_username);
      await botInstance.page.type('input[name="password"]', botInstance.config.panel_password);
      await botInstance.page.type('input[name="capt"]', captchaAnswer.toString());

      await Promise.all([
        botInstance.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
        botInstance.page.keyboard.press('Enter')
      ]);

      console.log(`✅ [${botInstance.id}] Browser initialized and logged in`);
      return true;
    } catch (err) {
      console.error(`❌ [${botInstance.id}] Browser init failed:`, err.message);
      this.log(botInstance.id, 'error', `Browser initialization failed: ${err.message}`);
      return false;
    }
  }

  async solveMathCaptcha(page) {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const result = await page.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const text = el.textContent.trim();
          if (!text) continue;
          
          let match = text.match(/(\d+)\s*\+\s*(\d+)/);
          if (match) {
            return parseInt(match[1]) + parseInt(match[2]);
          }
        }
        return null;
      });
      
      return result;
    } catch (err) {
      return null;
    }
  }

  async markExistingMessagesAsSent(botInstance) {
    try {
      console.log(`🔄 [${botInstance.id}] Marking existing messages as sent...`);
      const messages = await this.fetchLatestSMS(botInstance);
      
      messages.forEach(sms => {
        botInstance.sentMessageHashes.add(sms.hash);
      });
      
      this.saveSentMessages(botInstance);
      console.log(`✅ [${botInstance.id}] Marked ${messages.length} existing messages`);
    } catch (err) {
      console.error(`⚠️ [${botInstance.id}] Error marking messages:`, err.message);
    }
  }

  async fetchLatestSMS(botInstance) {
    try {
      if (!botInstance.page || !botInstance.browser) {
        return [];
      }

      await botInstance.page.goto(botInstance.config.sms_reports_url, { 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      });

      let responseData = null;
      const responsePromise = new Promise((resolve) => {
        const handler = async (response) => {
          const url = response.url();
          if (url.includes('data_smscdr.php')) {
            try {
              const data = await response.json();
              resolve(data);
              botInstance.page.off('response', handler);
            } catch (err) {
              // Ignore
            }
          }
        };
        botInstance.page.on('response', handler);
        
        setTimeout(() => {
          botInstance.page.off('response', handler);
          resolve(null);
        }, 15000);
      });

      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await botInstance.page.evaluate(() => {
        if (typeof jQuery !== 'undefined' && jQuery.fn.dataTable) {
          try {
            const table = jQuery('table').DataTable();
            if (table) table.ajax.reload();
          } catch (e) {}
        }
      });

      responseData = await responsePromise;

      if (responseData && responseData.aaData) {
        botInstance.lastSuccessfulPoll = Date.now();
        
        const messages = responseData.aaData
          .filter((row) => {
            const hasMessage = row[5] && row[5].trim().length > 0;
            const hasSource = row[3] && row[3].trim().length > 0;
            const hasDestination = row[2] && row[2].trim().length > 0;
            return hasMessage && (hasSource || hasDestination);
          })
          .map((row) => {
            const msgData = `${row[0]}_${row[2]}_${row[3]}_${row[5]}`;
            const hash = crypto.createHash('md5').update(msgData).digest('hex');
            
            return {
              hash,
              date: row[0] || '',
              destination_addr: row[2] || '',
              source_addr: row[3] || '',
              client: row[4] || '',
              short_message: row[5] || ''
            };
          });
        
        return messages;
      }
      
      return [];
    } catch (err) {
      console.error(`❌ [${botInstance.id}] Fetch error:`, err.message);
      return [];
    }
  }

  // Helper function to mask phone number
  maskPhoneNumber(phoneNumber) {
    if (!phoneNumber || phoneNumber.length < 4) {
      return phoneNumber;
    }
    
    const length = phoneNumber.length;
    const visibleStart = Math.ceil(length / 3);
    const visibleEnd = Math.ceil(length / 3);
    
    const start = phoneNumber.substring(0, visibleStart);
    const end = phoneNumber.substring(length - visibleEnd);
    const mask = '****';
    
    return `${start}${mask}${end}`;
  }

  // Helper function to extract OTP from message
  extractOTP(message) {
    if (!message) return null;
    
    // Common OTP patterns
    const patterns = [
      /\b(\d{4,8})\b/g,           // 4-8 digit codes
      /code[:\s]+(\d{3,8})/gi,    // "code: 123456" or "code 123456"
      /otp[:\s]+(\d{3,8})/gi,     // "OTP: 123456"
      /verification[:\s]+(\d{3,8})/gi, // "verification: 123456"
      /(\d{3})-(\d{3})/g,         // Format like "322-641"
    ];
    
    for (const pattern of patterns) {
      const matches = message.match(pattern);
      if (matches && matches.length > 0) {
        // Return the first match, clean it up
        let otp = matches[0];
        // Remove common prefixes
        otp = otp.replace(/code[:\s]+/gi, '').replace(/otp[:\s]+/gi, '').replace(/verification[:\s]+/gi, '');
        return otp.trim();
      }
    }
    
    return null;
  }

  async sendOTPToTelegram(botInstance, sms) {
    try {
      const source = sms.source_addr || 'Unknown';
      const destination = sms.destination_addr || 'Unknown';
      const message = (sms.short_message || 'No content').replace(/\u0000/g, '');
      
      // Mask the phone numbers
      const maskedDestination = this.maskPhoneNumber(destination);
      
      // Extract OTP
      const extractedOTP = this.extractOTP(message);
      const otpLine = extractedOTP ? `🔑 *OTP:* \`${extractedOTP}\`\n\n` : '';

      const formatted = `
🔔 *NEW OTP RECEIVED*
━━━━━━━━━━━━━━━━━━━━
📤 *Source:* \`${source}\`
📱 *Destination:* \`${maskedDestination}\`
${otpLine}💬 *Message:*
\`\`\`
${message}
\`\`\`
━━━━━━━━━━━━━━━━━━━━
⏰ _${new Date().toLocaleString()}_
`;

      for (const chatId of botInstance.config.telegram_chat_ids) {
        try {
          await botInstance.telegramBot.sendMessage(chatId, formatted, { parse_mode: 'Markdown' });
          botInstance.otpsSentCount++; // Increment OTP sent counter
        } catch (err) {
          console.error(`❌ [${botInstance.id}] Send failed to ${chatId}:`, err.message);
        }
      }
    } catch (err) {
      console.error(`❌ [${botInstance.id}] Telegram error:`, err.message);
    }
  }

  async pollSMS(botInstance) {
    if (botInstance.isPolling) return;
    
    botInstance.isPolling = true;
    botInstance.pollCount++;

    try {
      const messages = await this.fetchLatestSMS(botInstance);
      
      if (messages.length) {
        let newCount = 0;
        for (const sms of messages) {
          if (!botInstance.sentMessageHashes.has(sms.hash)) {
            await this.sendOTPToTelegram(botInstance, sms);
            botInstance.sentMessageHashes.add(sms.hash);
            newCount++;
            
            if (botInstance.sentMessageHashes.size > 1000) {
              const hashArray = Array.from(botInstance.sentMessageHashes);
              botInstance.sentMessageHashes = new Set(hashArray.slice(-500));
            }
          }
        }
        
        if (newCount > 0) {
          this.log(botInstance.id, 'info', `Sent ${newCount} new OTP(s)`);
          this.saveSentMessages(botInstance);
        }
      }
    } catch (err) {
      this.log(botInstance.id, 'error', `Poll error: ${err.message}`);
    } finally {
      botInstance.isPolling = false;
    }
  }

  startPolling(botInstance) {
    // Initial poll
    this.pollSMS(botInstance);
    
    // Set up interval
    botInstance.pollInterval = setInterval(() => {
      this.pollSMS(botInstance);
    }, botInstance.config.poll_interval);

    // Health check
    botInstance.healthCheckInterval = setInterval(() => {
      this.performHealthCheck(botInstance);
    }, 60000);
  }

  performHealthCheck(botInstance) {
    const timeSinceLastPoll = Date.now() - botInstance.lastSuccessfulPoll;
    
    if (timeSinceLastPoll > 300000 && botInstance.browser) {
      console.log(`⚠️ [${botInstance.id}] No poll in 5min, reconnecting...`);
      this.log(botInstance.id, 'warning', 'Reconnecting browser due to inactivity');
      
      if (botInstance.browser) {
        botInstance.browser.close().catch(() => {});
      }
      botInstance.browser = null;
      botInstance.page = null;
      this.initializeBrowser(botInstance);
    }
  }

  // Calculate days remaining until expiry
  getDaysRemaining(expiresAt) {
    if (!expiresAt) return 'N/A';
    
    const now = new Date();
    const expiry = new Date(expiresAt);
    const diffTime = expiry - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) return 'Expired';
    if (diffDays === 0) return 'Expires Today';
    if (diffDays === 1) return '1 Day Left';
    return `${diffDays} Days Left`;
  }

  setupTelegramHandlers(botInstance) {
    botInstance.telegramBot.onText(/\/start/, (msg) => {
      botInstance.telegramBot.sendMessage(
        msg.chat.id,
        `🤖 OTP Bot active for ${botInstance.config.user_name}!\nUse /status to check connection.`
      );
    });

    botInstance.telegramBot.onText(/\/status/, (msg) => {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const timeSinceLastPoll = Date.now() - botInstance.lastSuccessfulPoll;
      const minutesSinceLastPoll = Math.floor(timeSinceLastPoll / 60000);
      const daysRemaining = this.getDaysRemaining(botInstance.config.expires_at);
      
      const statusMessage = `📊 *Bot Status - ${botInstance.config.user_name}*
━━━━━━━━━━━━━━━━━━━━

✅ *Status:* ${botInstance.browser ? 'Running' : 'Reconnecting...'}

📨 *OTPs Sent:* ${botInstance.otpsSentCount}

⏱️ *Poll Interval:* ${botInstance.config.poll_interval/1000}s

🌐 *Browser:* ${botInstance.browser ? 'Active ✅' : 'Inactive ❌'}

📡 *Active Channels:* ${botInstance.config.telegram_chat_ids.length}

📊 *Total Polls:* ${botInstance.pollCount}

🕐 *Last Poll:* ${minutesSinceLastPoll}m ago

⏰ *Uptime:* ${hours}h ${minutes}m

━━━━━━━━━━━━━━━━━━━━
💳 *Cost:* ${daysRemaining}`;
      
      botInstance.telegramBot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'Markdown' });
    });

    botInstance.telegramBot.on('polling_error', (error) => {
      console.error(`⚠️ [${botInstance.id}] Telegram error:`, error.message);
    });
  }

  async sendConnectionMessage(botInstance) {
    const daysRemaining = this.getDaysRemaining(botInstance.config.expires_at);
    
    const message = `✅ *OTP Bot Connected - ${botInstance.config.user_name}*

The bot is now active and monitoring for OTPs.
Use /status to check connection status.

⏱️ Poll interval: ${botInstance.config.poll_interval/1000}s
💳 Subscription: ${daysRemaining}`;
    
    for (const chatId of botInstance.config.telegram_chat_ids) {
      try {
        await botInstance.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`❌ [${botInstance.id}] Connection msg failed:`, err.message);
      }
    }
  }

  log(botId, type, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${botId}] [${type.toUpperCase()}] ${message}`);
    
    // Save to database
    this.db.run(
      'INSERT INTO bot_logs (bot_id, log_type, message) VALUES (?, ?, ?)',
      [botId, type, message]
    );
  }
}

module.exports = BotManager;
