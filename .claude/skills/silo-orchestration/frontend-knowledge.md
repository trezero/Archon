# Eskerium Frontend Knowledge Base

Comprehensive patterns and conventions for the Eskerium web-frontend (Next.js).

## Technology Stack

- **Framework:** Next.js 15 with App Router
- **Styling:** Tailwind CSS
- **Components:** Shadcn UI v4 (MANDATORY base)
- **Icons:** Lucide React ONLY
- **State:** Zustand stores
- **Forms:** React Hook Form + Zod validation
- **AI Integration:** Mastra + CopilotKit

---

## Silo API Integration

### Authentication Flow (OTP-based)

**Step 1: Request OTP**
```typescript
POST /api/auth/login/
{
  "grant_type": "otp",
  "username": "user@example.com"
}
// Returns HTTP 400 with "OTP sent" message
```

**Step 2: Verify OTP**
```typescript
POST /api/auth/login/
{
  "code": "123456"
}
// Returns JWT tokens (stored in httpOnly cookies)
```

**Required Header (ALL requests):**
```typescript
headers: {
  'X-ESK-VERSION': '1.0'  // Missing = 403 Forbidden
}
```

### Portal Access Control
- JWT claims include `portal_access` boolean
- Default for new users: `false` (requires admin approval)
- Admin endpoint: `POST /api/users/{user_id}/grant-portal-access/`
- Check via: `GET /api/auth/me/`

### Token Management
- **Refresh:** `POST /api/auth/refresh/` (reads from cookies)
- **Logout:** `POST /api/auth/logout/` (clears cookies)

---

## Profile Update Field Mapping (CRITICAL)

Use EXACT backend field names:

| Frontend Label | Backend Field |
|---------------|---------------|
| Phone | `phone_number` (NOT `phone`) - max 10 digits |
| Company | `business_name` (NOT `company`) |
| Extension | `phone_ext` |
| Secondary Phone | `secondary_phone_number` |
| Secondary Email | `secondary_email` |

**Response Data Location:**
- Display name: `profileData.contact.first_name` (contact table, NOT user)
- Business: `profileData.contact.business.name`, `.phone_number`

---

## Working API Patterns

### Verified Endpoints

```typescript
// Orders
getUserOrders()
getOrder(id)
createOrder()
updateOrder()
updateOrderStatus()

// Contacts
getContacts({ page, page_size, ordering })
getContact(id)
createContact()
updateContact()

// Products
getProducts()
getProduct(id)
createProduct()
updateProduct()

// Contact Submissions
getContactSubmissions()
updateContactSubmission()

// Dashboard
getDashboardStats()
getRecentOrders()
getTopCustomers()
```

### API Discovery
```typescript
GET /api/                    // List all endpoints
GET /api/?detailed=true      // With descriptions
GET /api/?category=ar        // Filter by category
GET /api/?search=order       // Search endpoints
```

---

## State Management (Zustand)

### Store Template

```typescript
interface StoreState {
  items: Item[]
  loading: boolean
  error: string | null
}

interface StoreActions {
  fetchItems: () => Promise<void>
}

type Store = StoreState & StoreActions

export const useStore = create<Store>()((set, get) => ({
  items: [],
  loading: false,
  error: null,

  fetchItems: async () => {
    set({ loading: true, error: null })
    try {
      const response = await api.getItems()
      set({ items: response.data, loading: false })
    } catch (error) {
      set({ error: error.message, loading: false })
    }
  }
}))
```

### Critical Rules

1. **ALWAYS use TypeScript types:** `create<StoreType>()()`
2. **NEVER mutate state:** Use spread operators, new arrays
3. **Store location:** ONLY `/lib/stores/` directory
4. **Async actions:** Must have `loading`/`error` states + try/catch
5. **Performance:** Use `useShallow` for multiple selections

### Anti-patterns

```typescript
// ❌ WRONG - Direct mutation
state.items.push(newItem)

// ✅ CORRECT - Immutable update
set({ items: [...state.items, newItem] })

// ❌ WRONG - No types
const useStore = create()

// ✅ CORRECT - With types
const useStore = create<Store>()

// ❌ WRONG - Inline object selector (causes infinite re-renders)
const { items, loading } = useStore(state => ({ items: state.items, loading: state.loading }))

// ✅ CORRECT - Individual selectors or useShallow
const items = useStore(state => state.items)
const loading = useStore(state => state.loading)
```

---

## UI Design System (Neo-Glassmorphism)

### Color Palette

```typescript
// Primary Gold (CTAs, highlights)
className="bg-gradient-to-r from-yellow-400 to-orange-500"

// Glass Backgrounds
className="bg-black/40 backdrop-blur-xl"
className="bg-gray-900/50"

// Neon Glows
const neonColors = {
  blue: '#4A9FFF',
  purple: '#A855F7',
  green: '#10B981',
  pink: '#EC4899'
}

// Text Hierarchy
const textColors = {
  primary: 'text-white',      // Headlines
  secondary: 'text-gray-300', // Descriptions
  tertiary: 'text-gray-400',  // Metadata
  muted: 'text-gray-500'      // Placeholders
}
```

### Component Patterns

**Card Design:**
```tsx
<div className="bg-black/40 backdrop-blur-xl border border-white/10 hover:bg-black/60 rounded-lg p-4">
```

**Primary Button:**
```tsx
<Button className="bg-gradient-to-r from-yellow-400 to-orange-500 text-black font-semibold">
```

**Secondary Button:**
```tsx
<Button variant="outline" className="border-yellow-500 text-yellow-500">
```

**Form Input:**
```tsx
<Input className="bg-gray-900/50 border-gray-700 focus:border-purple-500" />
```

### Neon Glow Icons

```tsx
<Icon className="drop-shadow-[0_0_2px_#4A9FFF] drop-shadow-[0_0_4px_#4A9FFF] drop-shadow-[0_0_8px_#4A9FFF] drop-shadow-[0_0_16px_#4A9FFF]" />
```

### Layout Rules

| Use Modals For | Use Pages For |
|----------------|---------------|
| CRUD operations | Major workflow changes |
| Quick actions | Login/logout |
| Detail views | Different functional areas |
| Forms | - |
| Confirmations | - |

---

## UI Anti-patterns (AVOID)

- ❌ UI components from scratch - wrap Shadcn primitives
- ❌ Icons other than Lucide React
- ❌ Browser alerts/confirms - use Shadcn AlertDialog
- ❌ Direct API calls in components - use Zustand stores
- ❌ Page navigation for CRUD - use Dialog modals
- ❌ Solid backgrounds on glass elements
- ❌ Inconsistent neon glow implementations

---

## Testing with Playwright

### Application URLs
- Customer portal: `http://localhost:8080/portal`
- Admin dashboard: `http://localhost:8080/silo/crm/dashboard`

### Test Credentials
- Customer: `test@example.com` / `Eskerium2020`
- Admin: `admin@example.com` / `admin123`

### Testing Workflow
```typescript
// 1. Navigate
mcp__playwright__browser_navigate(url="http://localhost:8080/portal")

// 2. Snapshot for context
mcp__playwright__browser_snapshot()

// 3. Interact
// click, type, fill forms...

// 4. Verify
mcp__playwright__browser_console_messages()  // Check for errors
```

### Validation Checklist
- [ ] Page loads without errors
- [ ] Interactive elements clickable
- [ ] Forms fillable and submittable
- [ ] Modals centered in viewport
- [ ] Responsive (no overflow)
- [ ] Loading/error states display
- [ ] No console errors

---

## Mastra-CopilotKit Integration

### Critical Rules (2025)

1. **ALWAYS use `streamVNext()`** - NOT legacy `stream()`
2. **ALWAYS define Zod schemas** for working memory
3. **Set `format: 'aisdk'`** for CopilotKit compatibility
4. **Implement processors** (input/output validation)
5. **No hardcoded API keys**

### Agent Configuration

```typescript
const AgentStateSchema = z.object({
  project: z.string(),
  users: z.array(UserSchema),
  settings: z.object({ theme: z.enum(['light', 'dark']) })
});

const agent = new Agent({
  memory: new Memory({
    options: {
      workingMemory: {
        enabled: true,
        schema: AgentStateSchema  // REQUIRED
      }
    }
  }),
  inputProcessors: [new ValidationProcessor()],
  outputProcessors: [new TokenLimiterProcessor()],
  defaultVNextStreamOptions: { format: 'aisdk' }
});
```

### Tool Binding (CRITICAL)

Frontend action name MUST match agent's tools **property name**:

```typescript
// Backend - property name is the key
const agent = new Agent({
  tools: { searchContactsTool }  // "searchContactsTool" is the name
});

// Frontend - must match property name
useCopilotAction({
  name: 'searchContactsTool',  // Match exactly
  available: 'frontend'
});
```

### Server Tools
- Use `serverFetchx()` for auth headers, NOT browser fetch
- Return SINGLE definitive result (best match, not array)
- Use `execute: async ({ context })` - NOT `{ input }`

### Anti-patterns
- ❌ Legacy `stream()` method
- ❌ Missing Zod schemas
- ❌ `format: 'mastra'` for CopilotKit
- ❌ No processors configured
- ❌ Hardcoded API keys
- ❌ `{ input }` destructuring instead of `{ context }`
- ❌ Removing `ExperimentalEmptyAdapter`

---

## Performance Optimization

### Priority Order

1. **Eliminate Waterfalls**
   - Move await into branches
   - Use `Promise.all()` for independent operations
   - Use Suspense for streaming

2. **Bundle Size**
   - Import directly, avoid barrel files
   - Use `next/dynamic` for heavy components
   - Load third-party after hydration

3. **Server-Side**
   - Use `React.cache()` for request deduplication
   - Minimize data passed to client
   - Parallelize fetches in RSC

4. **Client-Side**
   - Use SWR for request deduplication
   - Deduplicate global event listeners
   - Use passive event listeners for scroll

5. **Re-renders**
   - Don't subscribe to state only used in callbacks
   - Extract expensive work into memoized components
   - Use primitive dependencies in effects
   - Use `startTransition` for non-urgent updates
