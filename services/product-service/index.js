const express = require('express')
const jwt = require('jsonwebtoken')
const { Sequelize, DataTypes } = require('sequelize')
const swaggerUi = require('swagger-ui-express')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'

// ---------- Database ----------
const sequelize = new Sequelize(
  process.env.DB_NAME || 'product_db',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASS || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  },
)

const Product = sequelize.define('Product', {
  name: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.INTEGER, allowNull: false },
  stock: { type: DataTypes.INTEGER, defaultValue: 0 },
})

// ---------- RBAC middleware (pertemuan 9) ----------
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'token dibutuhkan' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (payload.role !== 'admin') return res.status(403).json({ error: 'butuh role admin' })
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ error: 'token tidak valid' })
  }
}

app.get('/health', (req, res) => res.json({ service: 'product-service', status: 'UP' }))

// ---------- Swagger ----------
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup({
    openapi: '3.0.0',
    info: {
      title: 'Product Service',
      version: '1.0.0',
      description: 'Layanan katalog produk (REST + Postgres). Membuat produk memerlukan role admin.',
    },
    servers: [{ url: '/', description: 'Product service' }],
    tags: [{ name: 'Products' }, { name: 'Health' }],
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
      '/products': {
        get: {
          tags: ['Products'],
          summary: 'Daftar semua produk',
          responses: {
            200: {
              description: 'Daftar produk',
              content: {
                'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } },
              },
            },
          },
        },
        post: {
          tags: ['Products'],
          summary: 'Buat produk baru (admin)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductInput' } } },
          },
          responses: {
            201: {
              description: 'Produk berhasil dibuat',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
            },
            400: {
              description: 'name / price tidak diisi',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            401: {
              description: 'token tidak ada / tidak valid',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            403: {
              description: 'butuh role admin',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
      '/products/{id}': {
        get: {
          tags: ['Products'],
          summary: 'Detail satu produk',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
              description: 'ID produk',
            },
          ],
          responses: {
            200: {
              description: 'Detail produk',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
            },
            404: {
              description: 'Produk tidak ditemukan',
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
        Product: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string', example: 'Kopi Arabika 250g' },
            price: { type: 'integer', example: 85000 },
            stock: { type: 'integer', example: 40 },
          },
        },
        ProductInput: {
          type: 'object',
          required: ['name', 'price'],
          properties: {
            name: { type: 'string', example: 'Kopi Arabika 250g' },
            price: { type: 'integer', example: 85000 },
            stock: { type: 'integer', example: 40, default: 0 },
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
app.get('/products', async (req, res) => res.json(await Product.findAll({ order: [['id', 'ASC']] })))

app.get('/products/:id', async (req, res) => {
  const p = await Product.findByPk(req.params.id)
  if (!p) return res.status(404).json({ error: 'product not found' })
  res.json(p)
})

app.post('/products', requireAdmin, async (req, res) => {
  const { name, price, stock } = req.body || {}
  if (!name || price == null) return res.status(400).json({ error: 'name & price wajib' })
  const p = await Product.create({ name, price, stock: stock || 0 })
  res.status(201).json(p)
})

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
  if ((await Product.count()) === 0) {
    await Product.bulkCreate([
      { name: 'Kopi Arabika 250g', price: 85000, stock: 40 },
      { name: 'Teh Hijau 100g', price: 45000, stock: 100 },
      { name: 'Gula Aren 500g', price: 30000, stock: 25 },
    ])
    console.log('[seed] 3 produk awal dibuat')
  }
  app.listen(PORT, () => console.log(`product-service listening on :${PORT}`))
}
start()
