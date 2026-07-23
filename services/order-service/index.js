const express = require('express')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const { Sequelize, DataTypes } = require('sequelize')
const swaggerUi = require('swagger-ui-express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3002
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'
const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3001'

// ---------- Database ----------
const sequelize = new Sequelize(
  process.env.DB_NAME || 'order_db',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASS || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  },
)

const Order = sequelize.define('Order', {
  userId: DataTypes.INTEGER,
  productId: DataTypes.INTEGER,
  qty: DataTypes.INTEGER,
  productName: DataTypes.STRING,
  price: DataTypes.INTEGER,
  total: DataTypes.INTEGER,
  status: DataTypes.STRING, // CONFIRMED
})

// ---------- Auth middleware (pertemuan 9) ----------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'login dulu (token dibutuhkan)' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'token tidak valid' })
  }
}

// Panggilan langsung ke product-service — TANPA retry / circuit breaker.
// Sengaja dibuat "polos" di pertemuan ini: kalau product-service lambat/mati,
// panggilan ini ikut gagal apa adanya. Ini jadi motivasi topik Circuit Breaker
// & Retry di pertemuan berikutnya (pertemuan 10).
async function fetchProduct(productId) {
  const { data } = await axios.get(`${PRODUCT_URL}/products/${productId}`, { timeout: 5000 })
  return data
}

// ---------- Swagger ----------
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup({
    openapi: '3.0.0',
    info: { title: 'Order Service', version: '1.0.0' },
    paths: {
      '/orders': { get: { summary: 'Order milik user (auth)' }, post: { summary: 'Buat order (auth)' } },
    },
  }),
)

// ---------- Routes ----------
app.get('/health', (req, res) => res.json({ service: 'order-service', status: 'UP' }))

app.post('/orders', requireAuth, async (req, res) => {
  const { productId, qty = 1 } = req.body || {}
  if (!productId) return res.status(400).json({ error: 'productId wajib' })

  let product
  try {
    product = await fetchProduct(productId)
  } catch (e) {
    // Tanpa fallback: kalau product-service bermasalah, order ikut gagal.
    return res.status(502).json({ error: 'product-service tidak bisa dihubungi', detail: e.message })
  }

  const total = product.price * qty
  const order = await Order.create({
    userId: req.user.id,
    productId,
    qty,
    productName: product.name,
    price: product.price,
    total,
    status: 'CONFIRMED',
  })

  res.status(201).json(order)
})

app.get('/orders', requireAuth, async (req, res) =>
  res.json(await Order.findAll({ where: { userId: req.user.id }, order: [['id', 'DESC']] })),
)

// ---------- Bootstrap ----------
async function start() {
  for (let i = 1; i <= 15; i++) {
    try {
      await sequelize.authenticate()
      break
    } catch (e) {
      console.log(`[db] belum siap (${i}/15): ${e.message}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  await sequelize.sync()
  app.listen(PORT, () =>
    console.log(`order-service listening on :${PORT} -> product:${PRODUCT_URL}`),
  )
}
start()
