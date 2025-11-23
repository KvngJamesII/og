const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const BotManager = require('./BotManager');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite Database
const db = new sqlite3.Database('./bots.db', (err) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_configs (
      id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      panel_username TEXT NOT NULL,
      panel_password TEXT NOT NULL,
      login_url TEXT NOT NULL,
      sms_reports_url TEXT NOT NULL,
      telegram_bot_token TEXT NOT NULL,
      telegram_chat_ids TEXT NOT NULL,
      poll_interval INTEGER DEFAULT 30000,
      status TEXT DEFAULT 'stopped',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('❌ Error creating table:', err);
    } else {
      console.log('✅ Database tables initialized');
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS bot_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      log_type TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bot_id) REFERENCES bot_configs(id) ON DELETE CASCADE
    )
  `);
}

// Bot Manager Instance
const botManager = new BotManager(db);

// API Routes

// Get all bots
app.get('/api/bots', (req, res) => {
  db.all('SELECT * FROM bot_configs ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    // Parse chat IDs and hide sensitive info
    const bots = rows.map(bot => ({
      ...bot,
      telegram_chat_ids: JSON.parse(bot.telegram_chat_ids),
      panel_password: '••••••••',
      telegram_bot_token: bot.telegram_bot_token.substring(0, 10) + '...'
    }));
    
    res.json(bots);
  });
});

// Get single bot
app.get('/api/bots/:id', (req, res) => {
  db.get('SELECT * FROM bot_configs WHERE id = ?', [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    row.telegram_chat_ids = JSON.parse(row.telegram_chat_ids);
    res.json(row);
  });
});

// Create new bot
app.post('/api/bots', (req, res) => {
  const {
    user_name,
    panel_username,
    panel_password,
    login_url,
    sms_reports_url,
    telegram_bot_token,
    telegram_chat_ids,
    poll_interval
  } = req.body;

  // Validation
  if (!user_name || !panel_username || !panel_password || !telegram_bot_token || !telegram_chat_ids || telegram_chat_ids.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const id = crypto.randomBytes(16).toString('hex');
  const chatIdsJson = JSON.stringify(telegram_chat_ids);
  
  const finalLoginUrl = login_url || 'http://139.99.63.204/ints/login';
  const finalSmsReportsUrl = sms_reports_url || 'http://139.99.63.204/ints/agent/SMSCDRReports';
  const finalPollInterval = poll_interval || 30000;

  const query = `
    INSERT INTO bot_configs (
      id, user_name, panel_username, panel_password, login_url, 
      sms_reports_url, telegram_bot_token, telegram_chat_ids, poll_interval, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped')
  `;

  db.run(
    query,
    [id, user_name, panel_username, panel_password, finalLoginUrl, finalSmsReportsUrl, telegram_bot_token, chatIdsJson, finalPollInterval],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      res.json({
        id,
        message: 'Bot configuration created successfully',
        user_name
      });
    }
  );
});

// Update bot
app.put('/api/bots/:id', (req, res) => {
  const {
    user_name,
    panel_username,
    panel_password,
    login_url,
    sms_reports_url,
    telegram_bot_token,
    telegram_chat_ids,
    poll_interval
  } = req.body;

  const chatIdsJson = JSON.stringify(telegram_chat_ids);

  const query = `
    UPDATE bot_configs 
    SET user_name = ?, panel_username = ?, panel_password = ?, 
        login_url = ?, sms_reports_url = ?, telegram_bot_token = ?, 
        telegram_chat_ids = ?, poll_interval = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(
    query,
    [user_name, panel_username, panel_password, login_url, sms_reports_url, telegram_bot_token, chatIdsJson, poll_interval, req.params.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Bot not found' });
      }
      
      // Restart bot if it was running
      if (botManager.isRunning(req.params.id)) {
        botManager.stopBot(req.params.id);
        botManager.startBot(req.params.id);
      }
      
      res.json({ message: 'Bot updated successfully' });
    }
  );
});

// Delete bot
app.delete('/api/bots/:id', (req, res) => {
  // Stop bot if running
  if (botManager.isRunning(req.params.id)) {
    botManager.stopBot(req.params.id);
  }

  db.run('DELETE FROM bot_configs WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    res.json({ message: 'Bot deleted successfully' });
  });
});

// Start bot
app.post('/api/bots/:id/start', async (req, res) => {
  try {
    const result = await botManager.startBot(req.params.id);
    
    if (result.success) {
      db.run('UPDATE bot_configs SET status = ? WHERE id = ?', ['running', req.params.id]);
      res.json({ message: 'Bot started successfully' });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop bot
app.post('/api/bots/:id/stop', (req, res) => {
  try {
    botManager.stopBot(req.params.id);
    db.run('UPDATE bot_configs SET status = ? WHERE id = ?', ['stopped', req.params.id]);
    res.json({ message: 'Bot stopped successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get bot status
app.get('/api/bots/:id/status', (req, res) => {
  const isRunning = botManager.isRunning(req.params.id);
  const stats = botManager.getStats(req.params.id);
  
  res.json({
    running: isRunning,
    ...stats
  });
});

// Get bot logs
app.get('/api/bots/:id/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  
  db.all(
    'SELECT * FROM bot_logs WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?',
    [req.params.id, limit],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// Health check
app.get('/health', (req, res) => {
  const runningBots = botManager.getRunningBotsCount();
  
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    runningBots,
    timestamp: new Date().toISOString()
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Multi-Tenant OTP Bot Server`);
  console.log(`🌐 Server running on port ${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // Auto-start bots that were running
  db.all('SELECT id FROM bot_configs WHERE status = ?', ['running'], (err, rows) => {
    if (!err && rows.length > 0) {
      console.log(`🔄 Restarting ${rows.length} bot(s) that were running...`);
      rows.forEach(row => {
        botManager.startBot(row.id);
      });
    }
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  await botManager.stopAllBots();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down server...');
  await botManager.stopAllBots();
  db.close();
  process.exit(0);
});
