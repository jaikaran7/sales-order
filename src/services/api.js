import axios from 'axios'

function pageHostIsLocalDevice() {
  try {
    const h = globalThis.window?.location?.hostname
    if (!h) return true
    return /^(localhost|127\.0\.0\.1)$/i.test(h)
  } catch {
    return true
  }
}

function resolveApiBaseUrl() {
  const fromEnv = import.meta.env.VITE_API_URL?.trim()
  if (fromEnv) {
    const pointsToLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(fromEnv)
    // Guard production builds from accidentally using local API URLs.
    if (import.meta.env.PROD && pointsToLocalhost) return '/_/backend/api'
    // On a phone/tablet at http://<LAN-IP>:5173, env localhost points at the device, not the dev PC.
    // Same-origin /api lets the Vite dev server proxy to the real backend on the PC.
    if (import.meta.env.DEV && pointsToLocalhost && !pageHostIsLocalDevice()) return '/api'
    return fromEnv
  }
  // Dev + Vite proxy: works for both http://localhost:5173 and http://<LAN-IP>:5173
  if (import.meta.env.DEV) return '/api'
  // Vercel multi-service backend routePrefix
  return '/_/backend/api'
}

const BASE_URL = resolveApiBaseUrl()

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
})

// Attach JWT token from localStorage on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('skm_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Handle 401 → redirect to login
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true
      const refreshToken = localStorage.getItem('skm_refresh')
      if (refreshToken) {
        try {
          const { data } = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken })
          const newToken = data.data.token
          localStorage.setItem('skm_token', newToken)
          original.headers.Authorization = `Bearer ${newToken}`
          return api(original)
        } catch {
          localStorage.removeItem('skm_token')
          localStorage.removeItem('skm_refresh')
          localStorage.removeItem('skm_role')
          window.location.href = '/login'
        }
      } else {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  },
)

export default api

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  logout: (refreshToken) => api.post('/auth/logout', { refreshToken }),
  me: () => api.get('/auth/me'),
}

// ─── Branches ─────────────────────────────────────────────────────────────────
export const branchesApi = {
  list: (params) => api.get('/branches', { params }),
  getOne: (id, params) => api.get(`/branches/${id}`, { params }),
  create: (data) => api.post('/branches', data),
  update: (id, data) => api.patch(`/branches/${id}`, data),
  remove: (id, config) => api.delete(`/branches/${id}`, config),
  getKpis: (id) => api.get(`/branches/${id}/kpis`),
  getClasses: (id) => api.get(`/branches/${id}/classes`),
  getStudents: (branchId, classId, filters) =>
    api.get(`/branches/${branchId}/classes/${classId}/students`, { params: filters }),
  bulkCreateStudents: (branchId, data) => api.post(`/branches/${branchId}/students/bulk`, data),
  createStudent: (branchId, data) => api.post(`/branches/${branchId}/students`, data),
}

// ─── Inventory ────────────────────────────────────────────────────────────────
export const inventoryApi = {
  getKpis: (params) => api.get('/inventory/kpis', { params }),
  /** Large nested payload — allow slow DB/serialization without client abort. */
  listBooks: (params) => api.get('/inventory/books', { params, timeout: 120000 }),
  getBookKit: (kitId, params) => api.get(`/inventory/books/${kitId}`, { params }),
  updateBookStock: (kitId, data) => api.patch(`/inventory/books/${kitId}/stock`, data),
  bulkAdjustBookStock: (data) => api.post('/inventory/books/bulk-adjust', data),
  createProduct: (data) => api.post('/inventory/products', data),
  updateProduct: (itemId, data) => api.patch(`/inventory/products/${itemId}`, data),
  archiveProduct: (itemId) => api.delete(`/inventory/products/${itemId}`),
  restoreProduct: (itemId) => api.patch(`/inventory/products/${itemId}/restore`),
  listUniformCategories: () => api.get('/inventory/uniforms/categories'),
  listUniforms: (params) => api.get('/inventory/uniforms', { params }),
  createUniformProduct: (data) => api.post('/inventory/uniforms/products', data),
  updateUniformProduct: (categoryId, data) => api.patch(`/inventory/uniforms/products/${categoryId}`, data),
  bulkAdjustUniformStock: (data) => api.post('/inventory/uniforms/bulk-adjust', data),
  updateUniformStock: (sizeId, data) => api.patch(`/inventory/uniforms/${sizeId}/stock`, data),
  listAccessories: (params) => api.get('/inventory/accessories', { params }),
  updateAccessoryStock: (accessoryId, data) => api.patch(`/inventory/accessories/${accessoryId}/stock`, data),
  getLogs: (params) => api.get('/inventory/logs', { params }),
}

// ─── Publishers / Accounts ────────────────────────────────────────────────────
export const publishersApi = {
  dashboard: () => api.get('/publishers/dashboard'),
  list: () => api.get('/publishers'),
  getOne: (id) => api.get(`/publishers/${id}`),
  create: (data) => api.post('/publishers', data),
  update: (id, data) => api.patch(`/publishers/${id}`, data),
  listProcurements: (params) => api.get('/publishers/procurements/list', { params }),
  createProcurement: (data) => api.post('/publishers/procurements', data),
  addPayment: (publisherId, data) => api.post(`/publishers/${publisherId}/payments`, data),
}

// ─── Stock Transfers ──────────────────────────────────────────────────────────
export const transfersApi = {
  list: (params) => api.get('/transfers', { params }),
  create: (data) => api.post('/transfers', data),
  getOne: (id) => api.get(`/transfers/${id}`),
  updateStatus: (id, status) => api.patch(`/transfers/${id}/status`, { status }),
}

// ─── Orders ───────────────────────────────────────────────────────────────────
export const ordersApi = {
  list: (params) => api.get('/orders', { params }),
  create: (data) => api.post('/orders', data),
  getOne: (id) => api.get(`/orders/${id}`),
  update: (id, data) => api.patch(`/orders/${id}`, data),
  processPayment: (id, data) => api.post(`/orders/${id}/payment`, data),
  createGroup: (data) => api.post('/orders/group', data),
  getGroup: (groupId) => api.get(`/orders/group/${encodeURIComponent(groupId)}`),
  getStudentOrders: (studentId) => api.get(`/orders/students/${encodeURIComponent(studentId)}`),
  cancel: (id) => api.delete(`/orders/${id}`),
  createEditRequest: (id, data) => api.post(`/orders/${id}/edit-requests`, data),
  listEditRequests: (params) => api.get('/orders/edit-requests', { params }),
  getEditRequest: (requestId) => api.get(`/orders/edit-requests/${requestId}`),
  approveEditRequest: (requestId, data) => api.post(`/orders/edit-requests/${requestId}/approve`, data ?? {}),
  rejectEditRequest: (requestId, data) => api.post(`/orders/edit-requests/${requestId}/reject`, data ?? {}),
  withdrawEditRequest: (requestId) => api.post(`/orders/edit-requests/${requestId}/withdraw`),
}

// ─── Transactions ─────────────────────────────────────────────────────────────
export const transactionsApi = {
  getKpis: (params) => api.get('/transactions/kpis', { params }),
  list: (params) => api.get('/transactions', { params }),
  listByStudent: (params) => api.get('/transactions/students', { params }),
  getDues: (params) => api.get('/transactions/dues', { params }),
  getOne: (id) => {
    const normalized = decodeURIComponent(String(id ?? ''))
    return api.get(`/transactions/${encodeURIComponent(normalized)}`)
  },
  getGroup: (groupId) => api.get(`/orders/group/${encodeURIComponent(groupId)}`),
}

// ─── New Admissions (standalone module) ──────────────────────────────────────
export const admissionsApi = {
  list: (params) => api.get('/admissions', { params }),
  create: (data) => api.post('/admissions', data),
  getOne: (id) => api.get(`/admissions/${id}`),
  update: (id, data) => api.patch(`/admissions/${id}`, data),
  processPayment: (id, data) => api.post(`/admissions/${id}/payment`, data),
  listTransactions: (params) => api.get('/admissions/transactions', { params }),
  getSettings: (params) => api.get('/admissions/settings', { params }),
  updateSettings: (data) => api.put('/admissions/settings', data),
}

// ─── Admin Management ─────────────────────────────────────────────────────────
export const adminMgmtApi = {
  list: () => api.get('/admins'),
  create: (data) => api.post('/admins', data),
  update: (id, data) => api.patch(`/admins/${id}`, data),
  resetPassword: (id, password) => api.post(`/admins/${id}/reset-password`, { password }),
  verifySuperPassword: (password) => api.post('/super/verify-password', { password }),
  delete: (id, superPassword) => api.delete(`/admins/${id}`, { data: { superPassword } }),
}

// ─── Meta (reference data) ───────────────────────────────────────────────────
/** Reference data for filters, dropdowns (payment methods, class grades, etc.). */
export const metaApi = {
  /** @param {import('axios').AxiosRequestConfig} [config] e.g. `{ params: { branchId } }` */
  catalog: (config) => api.get('/meta/catalog', config),
}

// Sales analytics (HTTP prefix `/reports` — used by Sales Overview & dashboards)
export const reportsApi = {
  branchPerformance: (params) => api.get('/reports/branch-performance', { params }),
  salesTrend: (params) => api.get('/reports/sales-trend', { params }),
  superDashboard: (params) => api.get('/reports/super-dashboard', { params }),
  adminDashboard: (params) => api.get('/reports/admin-dashboard', { params }),
}
