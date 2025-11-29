const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const BotManager = require('./BotManager');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Session configuration
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET || 'otp-bot-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      credits INTEGER DEFAULT 0,
      is_approved INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('❌ Error creating users table:', err);
    } else {
      console.log('✅ Users table initialized');
      createAdminAccount();
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS bot_configs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      panel_username TEXT NOT NULL,
      panel_password TEXT NOT NULL,
      login_url TEXT NOT NULL DEFAULT 'https://honorable-desiredly-cleotilde.ngrok-free.dev/ints/login',
      sms_reports_url TEXT NOT NULL DEFAULT 'https://honorable-desiredly-cleotilde.ngrok-free.dev/ints/agent/SMSCDRReports',
      telegram_bot_token TEXT NOT NULL,
      telegram_chat_ids TEXT NOT NULL,
      poll_interval INTEGER DEFAULT 30000,
      status TEXT DEFAULT 'stopped',
      billing_plan TEXT DEFAULT 'weekly',
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

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

  db.run(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (!err) {
      db.run('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)',
        ['maintenance_mode', 'false']
      );
    }
  });
}

async function createAdminAccount() {
  const adminUsername = 'idledev';
  const adminPassword = '200715';
  
  db.get('SELECT * FROM users WHERE username = ?', [adminUsername], async (err, user) => {
    if (!user) {
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      const adminId = crypto.randomBytes(16).toString('hex');
      
      db.run(
        'INSERT INTO users (id, username, password, credits, is_approved, is_admin) VALUES (?, ?, ?, ?, ?, ?)',
        [adminId, adminUsername, hashedPassword, 999999, 1, 1],
        (err) => {
          if (!err) {
            console.log('✅ Admin account created: username=idledev, password=200715');
          }
        }
      );
    }
  });
}

const botManager = new BotManager(db);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = crypto.randomBytes(16).toString('hex');

    db.run(
      'INSERT INTO users (id, username, password, credits, is_approved) VALUES (?, ?, ?, ?, ?)',
      [userId, username, hashedPassword, 0, 0],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists' });
          }
          return res.status(500).json({ error: err.message });
        }

        res.json({
          message: 'Registration successful! Please wait for admin approval.',
          userId
        });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin === 1;
    req.session.isApproved = user.is_approved === 1;

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        credits: user.credits,
        isApproved: user.is_approved === 1,
        isAdmin: user.is_admin === 1
      }
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out successfully' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  db.get('SELECT id, username, credits, is_approved, is_admin FROM users WHERE id = ?', 
    [req.session.userId], 
    (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({
        id: user.id,
        username: user.username,
        credits: user.credits,
        isApproved: user.is_approved === 1,
        isAdmin: user.is_admin === 1
      });
    }
  );
});

// ADMIN ROUTES
app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all('SELECT id, username, credits, is_approved, is_admin, created_at FROM users ORDER BY created_at DESC', 
    [], 
    (err, users) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(users);
    }
  );
});

app.post('/api/admin/users/:userId/approve', requireAdmin, (req, res) => {
  const { userId } = req.params;

  db.run('UPDATE users SET is_approved = 1, credits = credits + 100 WHERE id = ?', 
    [userId], 
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      db.run(
        'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
        [userId, 100, 'admin_grant', 'Account approval bonus']
      );

      res.json({ message: 'User approved and 100 credits granted' });
    }
  );
});

app.post('/api/admin/users/:userId/gift-credits', requireAdmin, (req, res) => {
  const { userId } = req.params;
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  db.run('UPDATE users SET credits = credits + ? WHERE id = ?', 
    [amount, userId], 
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      db.run(
        'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
        [userId, amount, 'admin_grant', `Admin gifted ${amount} credits`]
      );

      res.json({ message: `${amount} credits gifted successfully` });
    }
  );
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const stats = {};

  db.get('SELECT COUNT(*) as total FROM users', [], (err, result) => {
    stats.totalUsers = result ? result.total : 0;

    db.get('SELECT COUNT(*) as total FROM users WHERE is_approved = 0', [], (err, result) => {
      stats.pendingApprovals = result ? result.total : 0;

      db.get('SELECT COUNT(*) as total FROM bot_configs', [], (err, result) => {
        stats.totalBots = result ? result.total : 0;

        db.get('SELECT COUNT(*) as total FROM bot_configs WHERE status = "running"', [], (err, result) => {
          stats.activeBots = result ? result.total : 0;

          res.json(stats);
        });
      });
    });
  });
});

app.get('/api/admin/maintenance', requireAdmin, (req, res) => {
  db.get('SELECT value FROM system_settings WHERE key = ?', ['maintenance_mode'], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ maintenanceMode: row ? row.value === 'true' : false });
  });
});

app.post('/api/admin/maintenance/toggle', requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  
  try {
    db.run(
      'UPDATE system_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
      [enabled ? 'true' : 'false', 'maintenance_mode'],
      async (err) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        if (enabled) {
          await botManager.enableMaintenanceMode();
        } else {
          await botManager.disableMaintenanceMode();
        }

        res.json({ 
          message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}`,
          maintenanceMode: enabled 
        });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/maintenance-status', (req, res) => {
  db.get('SELECT value FROM system_settings WHERE key = ?', ['maintenance_mode'], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ maintenanceMode: row ? row.value === 'true' : false });
  });
});

// BOT ROUTES
app.get('/api/bots', requireAuth, (req, res) => {
  const userId = req.session.isAdmin ? null : req.session.userId;
  const query = userId 
    ? 'SELECT * FROM bot_configs WHERE user_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM bot_configs ORDER BY created_at DESC';
  const params = userId ? [userId] : [];

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const bots = rows.map(bot => ({
      ...bot,
      telegram_chat_ids: JSON.parse(bot.telegram_chat_ids),
      panel_password: '••••••••',
      telegram_bot_token: bot.telegram_bot_token.substring(0, 10) + '...'
    }));
    
    res.json(bots);
  });
});

app.post('/api/bots', requireAuth, (req, res) => {
  db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!user.is_approved && !user.is_admin) {
      return res.status(403).json({ error: 'Account not approved yet' });
    }

    const {
      user_name,
      panel_username,
      panel_password,
      telegram_bot_token,
      telegram_chat_ids,
      billing_plan
    } = req.body;

    const validPlans = { weekly: 100, monthly: 400 };
    const plan = billing_plan || 'weekly';
    const cost = validPlans[plan];

    if (!cost) {
      return res.status(400).json({ error: 'Invalid billing plan' });
    }

    if (user.credits < cost && !user.is_admin) {
      return res.status(400).json({ 
        error: `Insufficient credits. You need ${cost} credits for ${plan} plan.` 
      });
    }

    if (!user_name || !panel_username || !panel_password || !telegram_bot_token || !telegram_chat_ids || telegram_chat_ids.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const id = crypto.randomBytes(16).toString('hex');
    const chatIdsJson = JSON.stringify(telegram_chat_ids);
    
    const expiryDays = plan === 'monthly' ? 30 : 7;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    const query = `
      INSERT INTO bot_configs (
        id, user_id, user_name, panel_username, panel_password, 
        telegram_bot_token, telegram_chat_ids, billing_plan, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped')
    `;

    db.run(
      query,
      [id, req.session.userId, user_name, panel_username, panel_password, telegram_bot_token, chatIdsJson, plan, expiresAt.toISOString()],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        if (!user.is_admin) {
          db.run('UPDATE users SET credits = credits - ? WHERE id = ?', [cost, req.session.userId]);
          
          db.run(
            'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
            [req.session.userId, -cost, 'bot_creation', `Created bot: ${user_name} (${plan})`]
          );
        }
        
        res.json({
          id,
          message: `Bot created successfully (${plan} plan)`,
          user_name,
          billing_plan: plan,
          cost,
          expiresAt: expiresAt.toISOString()
        });
      }
    );
  });
});

app.get('/api/bots/:id', requireAuth, (req, res) => {
  db.get('SELECT * FROM bot_configs WHERE id = ?', [req.params.id], (err, bot) => {
    if (err || !bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({
      ...bot,
      telegram_chat_ids: JSON.parse(bot.telegram_chat_ids),
      panel_password: '••••••••',
      telegram_bot_token: bot.telegram_bot_token.substring(0, 10) + '...'
    });
  });
});

app.post('/api/bots/:id/start', requireAuth, async (req, res) => {
  try {
    db.get('SELECT * FROM bot_configs WHERE id = ?', [req.params.id], async (err, bot) => {
      if (err || !bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const result = await botManager.startBot(req.params.id);
      
      if (result.success) {
        db.run('UPDATE bot_configs SET status = ? WHERE id = ?', ['running', req.params.id]);
        res.json({ message: 'Bot started successfully' });
      } else {
        res.status(500).json({ error: result.error });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bots/:id/stop', requireAuth, (req, res) => {
  db.get('SELECT * FROM bot_configs WHERE id = ?', [req.params.id], (err, bot) => {
    if (err || !bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    botManager.stopBot(req.params.id);
    db.run('UPDATE bot_configs SET status = ? WHERE id = ?', ['stopped', req.params.id]);
    res.json({ message: 'Bot stopped successfully' });
  });
});

app.delete('/api/bots/:id', requireAuth, (req, res) => {
  db.get('SELECT * FROM bot_configs WHERE id = ?', [req.params.id], (err, bot) => {
    if (err || !bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (botManager.isRunning(req.params.id)) {
      botManager.stopBot(req.params.id);
    }

    db.run('DELETE FROM bot_configs WHERE id = ?', [req.params.id], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ message: 'Bot deleted successfully' });
    });
  });
});

app.get('/api/bots/:id/logs', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  
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

app.get('/health', (req, res) => {
  const runningBots = botManager.getRunningBotsCount();
  
  db.get('SELECT value FROM system_settings WHERE key = ?', ['maintenance_mode'], (err, row) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      runningBots,
      maintenanceMode: row ? row.value === 'true' : false,
      timestamp: new Date().toISOString()
    });
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

setInterval(() => {
  db.all('SELECT * FROM bot_configs WHERE status = "running" AND expires_at <= datetime("now")', [], (err, bots) => {
    if (err || !bots) return;

    bots.forEach(bot => {
      db.get('SELECT * FROM users WHERE id = ?', [bot.user_id], (err, user) => {
        if (err || !user) return;

        const renewalCost = bot.billing_plan === 'monthly' ? 400 : 100;
        const renewalDays = bot.billing_plan === 'monthly' ? 30 : 7;

        if (user.is_admin || user.credits >= renewalCost) {
          const newExpiryDate = new Date(Date.now() + renewalDays * 24 * 60 * 60 * 1000);
          db.run('UPDATE bot_configs SET expires_at = ? WHERE id = ?', [newExpiryDate.toISOString(), bot.id]);
          
          if (!user.is_admin) {
            db.run('UPDATE users SET credits = credits - ? WHERE id = ?', [renewalCost, user.id]);
            db.run(
              'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
              [user.id, -renewalCost, 'auto_renewal', `Auto-renewed bot: ${bot.user_name} (${bot.billing_plan})`]
            );
          }
          
          console.log(`✅ Auto-renewed bot: ${bot.user_name} (${bot.billing_plan})`);
        } else {
          botManager.stopBot(bot.id);
          db.run('UPDATE bot_configs SET status = ? WHERE id = ?', ['stopped', bot.id]);
          console.log(`⏸️ Stopped bot due to insufficient credits: ${bot.user_name}`);
        }
      });
    });
  });
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Multi-Tenant OTP Bot Server v2.0`);
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`👤 Admin: username=idledev, password=200715`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  db.all('SELECT id FROM bot_configs WHERE status = ?', ['running'], (err, rows) => {
    if (!err && rows && rows.length > 0) {
      console.log(`🔄 Restarting ${rows.length} bot(s)...`);
      rows.forEach(row => {
        botManager.startBot(row.id);
      });
    }
  });
});

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
