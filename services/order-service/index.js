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
    info: {
      title: 'Order Service',
      version: '1.0.0',
      description: 'Layanan order (REST + Postgres + JWT). Memanggil product-service langsung untuk validasi harga/stok.',
    },
    servers: [{ url: '/', description: 'Order service' }],
    tags: [{ name: 'Orders' }, { name: 'Health' }],
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Cek status service',
          responses: {
            200: {
              description: 'Service UP',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthStatus' } } },
            },
          },
        },
      },
      '/orders': {
        get: {
          tags: ['Orders'],
          summary: 'Daftar order milik user yang sedang login',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Daftar order',
              content: {
                'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } },
              },
            },
            401: {
              description: 'token tidak ada / tidak valid',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
        post: {
          tags: ['Orders'],
          summary: 'Buat order baru',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderInput' } } },
          },
          responses: {
            201: {
              description: 'Order berhasil dibuat',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
            },
            400: {
              description: 'productId tidak diisi',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            401: {
              description: 'token tidak ada / tidak valid',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            502: {
              description: 'product-service tidak bisa dihubungi',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        HealthStatus: {
          type: 'object',
          properties: { service: { type: 'string' }, status: { type: 'string' } },
        },
        OrderInput: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'integer', example: 1 },
            qty: { type: 'integer', example: 2, default: 1 },
          },
        },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            userId: { type: 'integer' },
            productId: { type: 'integer' },
            qty: { type: 'integer' },
            productName: { type: 'string' },
            price: { type: 'integer' },
            total: { type: 'integer' },
            status: { type: 'string', example: 'CONFIRMED' },
          },
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
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
