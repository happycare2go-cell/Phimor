const express = require('express');
const cors = require('cors');
const adminAuth = require('./middleware/adminAuth');
const auth = require('./middleware/auth');

// นำเข้า Routes
const adminRoute = require('./routes/admin');
const externalRoute = require('./routes/external');
const webhookRoute = require('./routes/webhook');
const transportRoute = require('./routes/transport');
const centersRoute = require('./routes/centers');
const familyRoute = require('./routes/family');
const cardsRoute = require('./routes/cards');
const accessRoute = require('./routes/access');

const app = express();

// 1. เปิดใช้งาน CORS (สำคัญมากสำหรับ LIFF และการข้ามโดเมน)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Line-User-Id', 'X-Admin-Key']
}));

app.use(express.json());

// 2. จัดลำดับ Router ตามกฎ (Admin และ External ต้องมาก่อน)
app.use('/api/admin', adminAuth, adminRoute);
app.use('/api/external', externalRoute); 
app.use('/webhook', webhookRoute);

// 3. ป้องกัน API ที่เหลือด้วย Auth Middleware
app.use('/api', auth);
app.use('/api/transport', transportRoute);
app.use('/api/centers', centersRoute);
app.use('/api/family', familyRoute);
app.use('/api/cards', cardsRoute);
app.use('/api/access', accessRoute);

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'phimor-backend' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
