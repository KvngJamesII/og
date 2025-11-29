const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { db, admin } = require('./firebase-config');
const BotManager = require('./BotManager');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Session configuration - using memory store (acceptable for Cloud Run)
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Initialize Firebase collections
async function initializeDatabase() {
  try {
    // Check if admin user exists
    const usersRef = db.collection('users');
    const adminQuery = await usersRef.where('username', '==', 'idledev').limit(1).get();
    
    if (adminQuery.empty) {
      const hashedPassword = await bcrypt.hash('200715', 10);
      const adminId = crypto.randomBytes(16).toString('hex');
      
      await usersRef.doc(adminId).set({
        id: adminId,
        username: 'idledev',
        password: hashedPassword,
        credits: 999999,
        is_approved: true,
        is_admin: true,
        created_at: new Date(),
        updated_at: new Date()
      });
      
      console.log('✅ Admin account created: username=idledev, password=200715');
    }
    
    // Initialize system settings
    const settingsRef = db.collection('system_settings');
    const maintenanceDoc = await settingsRef.doc('maintenance_mode').get();
    if (!maintenanceDoc.exists) {
      await settingsRef.doc('maintenance_mode').set({
        key: 'maintenance_mode',
        value: 'false',
        updated_at: new Date()
      });
    }
    
    console.log('✅ Connected to Firebase Firestore');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
}

initializeDatabase();

// Bot Manager Instance - pass db to BotManager
const botManager = new BotManager(db);

// Middleware to check authentication
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Middleware to check admin
function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// AUTH ROUTES

// Register
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const usersRef = db.collection('users');
    const existingUser = await usersRef.where('username', '==', username).limit(1).get();
    
    if (!existingUser.empty) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = crypto.randomBytes(16).toString('hex');

    await usersRef.doc(userId).set({
      id: userId,
      username,
      password: hashedPassword,
      credits: 0,
      is_approved: false,
      is_admin: false,
      created_at: new Date(),
      updated_at: new Date()
    });

    res.json({
      message: 'Registration successful! Please wait for admin approval.',
      userId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const usersRef = db.collection('users');
    const userQuery = await usersRef.where('username', '==', username).limit(1).get();
    
    if (userQuery.empty) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const userDoc = userQuery.docs[0];
    const user = userDoc.data();

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;
    req.session.isApproved = user.is_approved;

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        credits: user.credits,
        isApproved: user.is_approved,
        isAdmin: user.is_admin
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out successfully' });
});

// Get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.session.userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userDoc.data();
    res.json({
      id: user.id,
      username: user.username,
      credits: user.credits,
      isApproved: user.is_approved,
      isAdmin: user.is_admin
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN ROUTES

// Get all users (admin only)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users')
      .orderBy('created_at', 'desc')
      .get();
    
    const users = usersSnapshot.docs.map(doc => {
      const user = doc.data();
      return {
        id: user.id,
        username: user.username,
        credits: user.credits,
        is_approved: user.is_approved,
        is_admin: user.is_admin,
        created_at: user.created_at
      };
    });

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve user (admin only)
app.post('/api/admin/users/:userId/approve', requireAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const userRef = db.collection('users').doc(userId);
    
    await userRef.update({
      is_approved: true,
      credits: admin.firestore.FieldValue.increment(100),
      updated_at: new Date()
    });

    // Log transaction
    await db.collection('credit_transactions').add({
      user_id: userId,
      amount: 100,
      type: 'admin_grant',
      description: 'Account approval bonus',
      created_at: new Date()
    });

    res.json({ message: 'User approved and 100 credits granted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gift credits (admin only)
app.post('/api/admin/users/:userId/gift-credits', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const userRef = db.collection('users').doc(userId);
    
    await userRef.update({
      credits: admin.firestore.FieldValue.increment(amount),
      updated_at: new Date()
    });

    // Log transaction
    await db.collection('credit_transactions').add({
      user_id: userId,
      amount: amount,
      type: 'admin_grant',
      description: `Admin gifted ${amount} credits`,
      created_at: new Date()
    });

    res.json({ message: `${amount} credits gifted successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get admin stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const botsSnapshot = await db.collection('bot_configs').get();
    
    const totalUsers = usersSnapshot.size;
    const pendingApprovals = usersSnapshot.docs.filter(doc => !doc.data().is_approved).length;
    const totalBots = botsSnapshot.size;
    const activeBots = botsSnapshot.docs.filter(doc => doc.data().status === 'running').length;

    res.json({
      totalUsers,
      pendingApprovals,
      totalBots,
      activeBots
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Maintenance mode endpoints
app.get('/api/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const maintenanceDoc = await db.collection('system_settings').doc('maintenance_mode').get();
    const isEnabled = maintenanceDoc.exists ? maintenanceDoc.data().value === 'true' : false;
    
    res.json({ maintenanceMode: isEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/maintenance/toggle', requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  
  try {
    await db.collection('system_settings').doc('maintenance_mode').set({
      key: 'maintenance_mode',
      value: enabled ? 'true' : 'false',
      updated_at: new Date()
    });

    if (enabled) {
      await botManager.enableMaintenanceMode();
    } else {
      await botManager.disableMaintenanceMode();
    }

    res.json({ 
      message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}`,
      maintenanceMode: enabled 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get maintenance status (public endpoint)
app.get('/api/maintenance-status', async (req, res) => {
  try {
    const maintenanceDoc = await db.collection('system_settings').doc('maintenance_mode').get();
    const isEnabled = maintenanceDoc.exists ? maintenanceDoc.data().value === 'true' : false;
    
    res.json({ maintenanceMode: isEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BOT ROUTES (Protected)

// Get user's bots
app.get('/api/bots', requireAuth, async (req, res) => {
  try {
    let query = db.collection('bot_configs');
    
    if (!req.session.isAdmin) {
      query = query.where('user_id', '==', req.session.userId);
    }
    
    const botsSnapshot = await query.orderBy('created_at', 'desc').get();
    
    const bots = botsSnapshot.docs.map(doc => {
      const bot = doc.data();
      return {
        ...bot,
        telegram_chat_ids: Array.isArray(bot.telegram_chat_ids) ? bot.telegram_chat_ids : [],
        panel_password: '••••••••',
        telegram_bot_token: bot.telegram_bot_token.substring(0, 10) + '...'
      };
    });
    
    res.json(bots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new bot
app.post('/api/bots', requireAuth, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.session.userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userDoc.data();
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

    const botId = crypto.randomBytes(16).toString('hex');
    const expiryDays = plan === 'monthly' ? 30 : 7;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    await db.collection('bot_configs').doc(botId).set({
      id: botId,
      user_id: req.session.userId,
      user_name,
      panel_username,
      panel_password,
      login_url: 'http://139.99.63.204/ints/login',
      sms_reports_url: 'http://139.99.63.204/ints/agent/SMSCDRReports',
      telegram_bot_token,
      telegram_chat_ids: telegram_chat_ids,
      poll_interval: 30000,
      status: 'stopped',
      billing_plan: plan,
      expires_at: expiresAt,
      created_at: new Date(),
      updated_at: new Date()
    });

    // Deduct credits (if not admin)
    if (!user.is_admin) {
      await db.collection('users').doc(req.session.userId).update({
        credits: admin.firestore.FieldValue.increment(-cost)
      });
      
      // Log transaction
      await db.collection('credit_transactions').add({
        user_id: req.session.userId,
        amount: -cost,
        type: 'bot_creation',
        description: `Created bot: ${user_name} (${plan})`,
        created_at: new Date()
      });
    }
    
    res.json({
      id: botId,
      message: `Bot created successfully (${plan} plan)`,
      user_name,
      billing_plan: plan,
      cost,
      expiresAt: expiresAt.toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single bot
app.get('/api/bots/:botId', requireAuth, async (req, res) => {
  try {
    const botDoc = await db.collection('bot_configs').doc(req.params.botId).get();
    
    if (!botDoc.exists) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const bot = botDoc.data();
    
    // Check authorization
    if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({
      ...bot,
      telegram_chat_ids: Array.isArray(bot.telegram_chat_ids) ? bot.telegram_chat_ids : [],
      panel_password: '••••••••',
      telegram_bot_token: bot.telegram_bot_token.substring(0, 10) + '...'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start bot
app.post('/api/bots/:botId/start', requireAuth, async (req, res) => {
  try {
    const botDoc = await db.collection('bot_configs').doc(req.params.botId).get();
    
    if (!botDoc.exists) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const bot = botDoc.data();
    
    if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await botManager.startBot(req.params.botId);
    
    if (result.success) {
      await db.collection('bot_configs').doc(req.params.botId).update({
        status: 'running',
        updated_at: new Date()
      });
      res.json({ message: 'Bot started successfully' });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop bot
app.post('/api/bots/:botId/stop', requireAuth, async (req, res) => {
  try {
    const botDoc = await db.collection('bot_configs').doc(req.params.botId).get();
    
    if (!botDoc.exists) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const bot = botDoc.data();
    
    if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await botManager.stopBot(req.params.botId);
    
    if (result.success) {
      await db.collection('bot_configs').doc(req.params.botId).update({
        status: 'stopped',
        updated_at: new Date()
      });
      res.json({ message: 'Bot stopped successfully' });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get bot logs
app.get('/api/bots/:botId/logs', requireAuth, async (req, res) => {
  try {
    const botDoc = await db.collection('bot_configs').doc(req.params.botId).get();
    
    if (!botDoc.exists) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const bot = botDoc.data();
    
    if (bot.user_id !== req.session.userId && !req.session.isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const logsSnapshot = await db.collection('bot_logs')
      .where('bot_id', '==', req.params.botId)
      .orderBy('timestamp', 'desc')
      .limit(100)
      .get();

    const logs = logsSnapshot.docs.map(doc => doc.data());
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Server startup
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
