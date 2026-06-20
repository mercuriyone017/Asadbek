const TelegramBot = require('node-telegram-bot-api');
const ICAFE_KEY = process.env.ICAFE_API_KEY;
const ICAFE_SERVER = process.env.ICAFE_SERVER;

async function icafeGet(endpoint) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ICAFE_SERVER,
      path: '/api/' + endpoint,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + ICAFE_KEY,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}
const express = require('express');
const fs = require('fs');
const path = require('path');

process.env.RAILWAY_PUBLIC_DOMAIN = 'meticulous-harmony-production-9c56.up.railway.app';
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── Simple JSON database ───
const DB_FILE = './db.json';
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, bookings: [], orders: [] }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── Get or create user ───
function getUser(telegramUser) {
  const db = loadDB();
  const id = String(telegramUser.id);
  if (!db.users[id]) {
    db.users[id] = {
      id,
      name: telegramUser.first_name + (telegramUser.last_name ? ' ' + telegramUser.last_name : ''),
      username: telegramUser.username || '',
      balance: 0,
      totalSpent: 0,
      level: 1,
      cashbackPercent: 3,
      sessions: 0,
      joinedAt: new Date().toISOString()
    };
    saveDB(db);
  }
  return db.users[id];
}

function updateUser(id, data) {
  const db = loadDB();
  db.users[String(id)] = { ...db.users[String(id)], ...data };
  saveDB(db);
}

function getLevelInfo(totalSpent) {
  if (totalSpent >= 15000000) return { level: 4, cashback: 10, next: null, nextAmount: null };
  if (totalSpent >= 7000000) return { level: 3, cashback: 7, next: 4, nextAmount: 15000000 };
  if (totalSpent >= 3000000) return { level: 2, cashback: 5, next: 3, nextAmount: 7000000 };
  return { level: 1, cashback: 3, next: 2, nextAmount: 3000000 };
}

// ─── /start ───
bot.onText(/\/icafe/, async (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  try {
    const computers = await icafeGet('computers');
    bot.sendMessage(msg.chat.id, '✅ iCafeCloud ulandi!\n\n' + JSON.stringify(computers).slice(0, 500));
  } catch(e) {
    bot.sendMessage(msg.chat.id, '❌ Xato: ' + e.message);
  }
});
bot.onText(/\/start/, (msg) => {
  const user = getUser(msg.from);
  const webAppUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/app`;

  bot.sendMessage(msg.chat.id,
    `🎮 *MIRAGE Game Club*'ga xush kelibsiz, ${user.name}!\n\n` +
    `Quyidagi tugma orqali ilovani oching:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{
          text: '🎮 MIRAGE App ni ochish',
          web_app: { url: webAppUrl }
        }]],
        resize_keyboard: true
      }
    }
  );
});

// ─── API endpoints ───

// Get user data
app.get('/api/user/:telegramId', (req, res) => {
  const db = loadDB();
  const user = db.users[req.params.telegramId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const levelInfo = getLevelInfo(user.totalSpent || 0);
  res.json({ ...user, ...levelInfo });
});

// Top up balance
app.post('/api/topup', (req, res) => {
  const { telegramId, amount, method } = req.body;
  const db = loadDB();
  const user = db.users[String(telegramId)];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cashbackPercent = user.cashbackPercent || 3;
  const cashback = Math.floor(amount * cashbackPercent / 100);
  user.balance = (user.balance || 0) + amount + cashback;

  db.users[String(telegramId)] = user;
  saveDB(db);

  // Notify admin
  bot.sendMessage(ADMIN_ID,
    `💳 *Balans to'ldirildi*\n\n` +
    `👤 ${user.name} (@${user.username})\n` +
    `💰 Summa: ${amount.toLocaleString()} so'm\n` +
    `🎁 Keshbek: ${cashback.toLocaleString()} so'm\n` +
    `💳 Usul: ${method}\n` +
    `💵 Yangi balans: ${user.balance.toLocaleString()} so'm`,
    { parse_mode: 'Markdown' }
  );

  // Notify user
  bot.sendMessage(telegramId,
    `✅ Balansingiz to'ldirildi!\n\n` +
    `➕ ${amount.toLocaleString()} so'm\n` +
    `🎁 Keshbek: +${cashback.toLocaleString()} so'm\n` +
    `💵 Joriy balans: ${user.balance.toLocaleString()} so'm`
  );

  res.json({ success: true, newBalance: user.balance, cashback });
});

// Create booking
app.post('/api/booking', (req, res) => {
  const { telegramId, pcId, pcName, time, duration, price } = req.body;
  const db = loadDB();
  const user = db.users[String(telegramId)];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < price) return res.status(400).json({ error: 'Balans yetarli emas' });

  user.balance -= price;
  user.totalSpent = (user.totalSpent || 0) + price;
  user.sessions = (user.sessions || 0) + 1;

  const levelInfo = getLevelInfo(user.totalSpent);
  user.level = levelInfo.level;
  user.cashbackPercent = levelInfo.cashback;

  const booking = {
    id: Date.now(),
    telegramId,
    userName: user.name,
    pcId, pcName, time, duration, price,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.bookings.push(booking);
  db.users[String(telegramId)] = user;
  saveDB(db);

  // Notify admin with confirm/cancel buttons
  bot.sendMessage(ADMIN_ID,
    `🖥️ *Yangi bron!*\n\n` +
    `👤 ${user.name} (@${user.username})\n` +
    `🖥️ ${pcName}\n` +
    `⏰ Vaqt: ${time}\n` +
    `⏱️ Davomiyligi: ${duration} soat\n` +
    `💰 Narx: ${price.toLocaleString()} so'm`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Tasdiqlash', callback_data: `confirm_${booking.id}` },
          { text: '❌ Bekor qilish', callback_data: `cancel_${booking.id}` }
        ]]
      }
    }
  );

  // Notify user
  bot.sendMessage(telegramId,
    `📋 *Bron so'rovi yuborildi!*\n\n` +
    `🖥️ ${pcName}\n` +
    `⏰ Vaqt: ${time}\n` +
    `⏱️ ${duration} soat\n` +
    `💰 ${price.toLocaleString()} so'm hisobdan chiqarildi\n\n` +
    `⏳ Admin tasdiqlashini kuting...`,
    { parse_mode: 'Markdown' }
  );

  res.json({ success: true, booking, newBalance: user.balance });
});

// Bar order
app.post('/api/order', (req, res) => {
  const { telegramId, items, total } = req.body;
  const db = loadDB();
  const user = db.users[String(telegramId)];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < total) return res.status(400).json({ error: 'Balans yetarli emas' });

  user.balance -= total;
  user.totalSpent = (user.totalSpent || 0) + total;

  const order = {
    id: Date.now(),
    telegramId,
    userName: user.name,
    items, total,
    status: 'new',
    createdAt: new Date().toISOString()
  };
  db.orders.push(order);
  db.users[String(telegramId)] = user;
  saveDB(db);

  const itemsList = items.map(i => `• ${i.emoji} ${i.name} ×${i.qty} — ${(i.price*i.qty).toLocaleString()}`).join('\n');

  // Notify admin
  bot.sendMessage(ADMIN_ID,
    `🍔 *Yangi buyurtma!*\n\n` +
    `👤 ${user.name}\n\n` +
    `${itemsList}\n\n` +
    `💰 Jami: ${total.toLocaleString()} so'm`,
    { parse_mode: 'Markdown' }
  );

  // Notify user
  bot.sendMessage(telegramId,
    `✅ Buyurtmangiz qabul qilindi!\n\n${itemsList}\n\n💰 ${total.toLocaleString()} so'm hisobdan chiqarildi`,
    { parse_mode: 'Markdown' }
  );

  res.json({ success: true, newBalance: user.balance });
});

// Admin: confirm/cancel booking
bot.on('callback_query', (query) => {
  const data = query.data;
  const db = loadDB();

  if (data.startsWith('confirm_')) {
    const bookingId = parseInt(data.replace('confirm_', ''));
    const booking = db.bookings.find(b => b.id === bookingId);
    if (booking) {
      booking.status = 'confirmed';
      saveDB(db);
      bot.sendMessage(booking.telegramId,
        `✅ *Broningiz tasdiqlandi!*\n\n🖥️ ${booking.pcName}\n⏰ ${booking.time}\n⏱️ ${booking.duration} soat\n\nSizni kutamiz! 🎮`,
        { parse_mode: 'Markdown' }
      );
      bot.editMessageText(`✅ Tasdiqlandi — ${booking.pcName} — ${booking.userName}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    }
  }

  if (data.startsWith('cancel_')) {
    const bookingId = parseInt(data.replace('cancel_', ''));
    const booking = db.bookings.find(b => b.id === bookingId);
    if (booking) {
      booking.status = 'cancelled';
      // Refund
      const user = db.users[String(booking.telegramId)];
      if (user) { user.balance += booking.price; db.users[String(booking.telegramId)] = user; }
      saveDB(db);
      bot.sendMessage(booking.telegramId,
        `❌ Broningiz bekor qilindi.\n\n💰 ${booking.price.toLocaleString()} so'm qaytarildi.`
      );
      bot.editMessageText(`❌ Bekor qilindi — ${booking.pcName} — ${booking.userName}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    }
  }

  bot.answerCallbackQuery(query.id);
});

// Admin commands
bot.onText(/\/stats/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const db = loadDB();
  const users = Object.values(db.users);
  const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
  const totalSpent = users.reduce((s, u) => s + (u.totalSpent || 0), 0);
  const todayBookings = db.bookings.filter(b => b.createdAt?.startsWith(new Date().toISOString().slice(0,10))).length;

  bot.sendMessage(msg.chat.id,
    `📊 *MIRAGE statistika*\n\n` +
    `👥 Jami mijozlar: ${users.length}\n` +
    `💰 Umumiy balanslar: ${totalBalance.toLocaleString()} so'm\n` +
    `📈 Jami aylanma: ${totalSpent.toLocaleString()} so'm\n` +
    `📅 Bugungi bronlar: ${todayBookings}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/users/, (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_ID)) return;
  const db = loadDB();
  const users = Object.values(db.users).slice(0, 20);
  const list = users.map(u =>
    `• ${u.name} — ${(u.balance||0).toLocaleString()} so'm (Level ${u.level})`
  ).join('\n');
  bot.sendMessage(msg.chat.id, `👥 *Mijozlar:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// Serve app
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.listen(PORT, () => console.log(`MIRAGE Bot running on port ${PORT}`));
