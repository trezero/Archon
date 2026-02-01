# Eskerium Backend Knowledge Base

Comprehensive patterns and conventions for the Silo backend (Django/DRF).

## Technology Stack

- **Framework:** Django 4.2.11 LTS (Python 3.9+)
- **REST API:** Django REST Framework 3.15.1
- **Authentication:** JWT via djangorestframework-simplejwt 5.3.1
- **Database:** PostgreSQL 13.14
- **Cache/Queue:** Redis (Alpine)
- **WebSockets:** Django Channels 4.1.0 with channels_redis
- **Server:** Gunicorn 22.0.0 with Uvicorn 0.29.0 (ASGI)
- **Storage:** Google Cloud Storage via django-storages
- **Platform:** Google Cloud Platform (App Engine, Cloud SQL)

---

## Project Architecture

### Dual Architecture
- **Legacy System:** Traditional server-rendered Django app (production)
- **Modern API Layer:** DRF-based REST API for Next.js frontend

### Directory Structure

```
silo/                   # Core Django settings
api/                   # Modern REST API
├── auth/             # JWT authentication & middleware
├── inventory/        # Product, batch, stock
├── crm/             # Contacts, customers
├── ar/              # Orders, invoicing
├── users/           # User management
├── feeds/           # Data exports
├── analytics/       # Analytics & reporting
├── quickbooks/      # QB integration
├── harvest/         # Harvest planning
├── core/            # Shared utilities (activity tracking)
└── urls.py          # API routing

inventory/crm/ar/    # Domain app models
templates/static/    # Legacy templates & assets
core/utils/         # Shared business utilities
```

---

## CRITICAL: Database Safety Rules

**THIS IS PRODUCTION DATA - EXTREME CAUTION REQUIRED**

### Safe Operations
- ✅ Adding new models
- ✅ Adding nullable fields (`null=True`)
- ✅ Adding fields with defaults
- ✅ Adding indexes
- ✅ Creating new tables
- ✅ Adding ManyToMany relationships

### Dangerous Operations (Require Discussion)
- ⚠️ Removing/renaming fields
- ⚠️ Changing field types
- ⚠️ Adding non-nullable fields without defaults
- ⚠️ Removing models/tables
- ⚠️ Changing primary keys
- ⚠️ Modifying unique constraints

### Migration Workflow

1. Review current data structure BEFORE any model change
2. Check for existing data that might be affected
3. Plan for data migration if needed
4. Create migration:
   ```bash
   docker-compose exec web python manage.py makemigrations
   ```
5. Review SQL:
   ```bash
   docker-compose exec web python manage.py sqlmigrate [app] [number]
   ```
6. Test first on dev database
7. Never change CharField max_length without data migration
8. ForeignKey on_delete must be carefully chosen
9. Removing `null=True` requires default or data migration

### Emergency Migration Rollback

```bash
# Rollback to previous migration
python manage.py migrate [app] [previous_number]

# Then:
# 1. Fix the issue in the model
# 2. Delete failed migration file
# 3. Create new migration
```

### Production Migration Checklist
- [ ] Backup database first
- [ ] Test on staging
- [ ] Review with team
- [ ] Plan downtime if needed
- [ ] Have rollback plan ready
- [ ] Monitor after deployment

---

## API Development Standards

### Required Header (ALL Requests)

```python
# Missing this returns 403 Forbidden
headers = {
    'Authorization': 'Bearer {jwt_token}',
    'X-ESK-VERSION': '1.0'
}
```

### Serializer Patterns

```python
# api/{module}/serializers.py
class ProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ['id', 'name', 'price', 'created_at']
        read_only_fields = ['id', 'created_at']
```

**Naming Conventions:**
- List/Read: `{Model}Serializer`
- Create: `{Model}CreateSerializer`
- Update: `{Model}UpdateSerializer`
- Detail: `{Model}DetailSerializer`

### ViewSet Patterns

```python
class ProductViewSet(viewsets.ModelViewSet):
    serializer_class = ProductSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        if self.request.user.is_staff:
            return Product.objects.all()
        return Product.objects.filter(user=self.request.user)

    def get_serializer_class(self):
        if self.action == 'create':
            return ProductCreateSerializer
        return ProductSerializer

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None):
        product = self.get_object()
        product.archived = True
        product.save()
        return Response({'status': 'archived'})
```

### URL Routing Order (CRITICAL)

```python
# api/urls.py - ORDER MATTERS!
urlpatterns = [
    # 1. Specific paths FIRST (exact matches)
    path('', APIIndexView.as_view(), name='api_index'),
    path('docs/', ...),
    path('schema/', ...),

    # 2. Module-specific routes
    path('auth/', include('api.auth.urls')),
    path('inventory/', include('api.inventory.urls')),

    # 3. Root-level DRF router LAST (catch-all)
    path('', include('api.harvest.urls')),
]
```

**Why:** Django processes in order. Specific paths MUST come before DRF routers using `path('')`.

### Error Response Format

```python
# Success (2xx)
return Response({
    'id': obj.id,
    'field': 'value'
}, status=status.HTTP_201_CREATED)

# Error (4xx)
return Response({
    'error': 'ValidationError',
    'message': 'Human-readable message',
    'details': {'field': 'specific error'}
}, status=status.HTTP_400_BAD_REQUEST)
```

---

## Key API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/api/auth/login/` | JWT authentication |
| `/api/auth/me/` | Current user info |
| `/api/auth/refresh/` | Token refresh |
| `/api/inventory/products/` | Product management |
| `/api/crm/contacts/` | Contact management |
| `/api/ar/orders/` | Order processing |
| `/api/harvest-plans/` | Harvest planning |
| `/api/pallets/` | Pallet tracking |
| `/api/containers/` | Container/hemp management |
| `/api/activity-feed/?source=all` | Activity tracking |

**CRITICAL: Never change these URLs to fix tests - fix the tests instead!**

---

## Testing Requirements

### Docker Must Be Running

```bash
./status.sh     # Check status
./start.sh      # Start if needed
```

### MANDATORY: Full Test Suite

```bash
# ALWAYS run ALL tests before marking task complete
docker-compose exec web python manage.py test

# This runs ~400+ tests - ALL must pass
# GitHub Actions runs full suite - failures block deployment
```

### Test Results Must Show
- `Ran XXX tests in X.XXXs`
- `OK` or `OK (skipped=XX)`
- **ZERO failures or errors**

### Test File Structure

```python
# api/tests/{module}/test_{feature}.py
class ProductAPITestCase(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(...)
        # REQUIRED: Add X-ESK-VERSION header
        self.client.credentials(HTTP_X_ESK_VERSION='1.0')
        self.client.force_authenticate(user=self.user)

    def test_list_products(self):
        response = self.client.get('/api/inventory/products/')
        self.assertEqual(response.status_code, 200)
```

### Specific Test Commands

```bash
# Fresh database (slower, guaranteed clean state)
docker-compose exec -T web python manage.py test --verbosity=1 --noinput

# Keep database (faster for iterative testing)
docker-compose exec -T web python manage.py test --verbosity=1 --keepdb

# Specific module
docker-compose exec -T web python manage.py test api.tests.harvest --verbosity=2
```

---

## Code Style Conventions

### Python/Django Standards
- **Follow PEP 8** and Django coding style guide
- **No type hints** currently used in codebase
- **Docstrings** for complex functions and classes

### Naming Convention
- `snake_case` for functions and variables
- `CamelCase` for classes and models
- `UPPER_SNAKE_CASE` for constants

### File Organization
- Models: `[app]/models.py`
- Views: `[app]/views.py` or `api/[module]/views.py`
- Serializers: `api/[module]/serializers.py`
- URLs: `[app]/urls.py` + main `urls.py`
- Tests: `[app]/tests.py` or `api/tests/`

---

## Docker Commands

### Service Management

```bash
# Build and start
docker-compose up --build

# Start (no rebuild)
docker-compose up

# Stop all
docker-compose down

# Restart Django only
docker-compose restart web

# Reset database (WARNING: deletes data!)
docker-compose down -v
```

### Django Management

```bash
docker-compose exec web python manage.py migrate
docker-compose exec web python manage.py makemigrations
docker-compose exec web python manage.py createsuperuser
docker-compose exec web python manage.py shell
docker-compose exec web python manage.py dbshell
docker-compose exec web python manage.py check
docker-compose exec web python manage.py check --deploy
```

### Debugging

```bash
docker-compose logs -f web
docker-compose logs -f db
docker-compose ps
docker exec -it silo_web_1 bash
```

---

## Common Patterns

### Activity Tracking

```python
from api.core.mixins import ActivityMixin

class MyModel(ActivityMixin, models.Model):
    activity = models.JSONField(default=dict, blank=True)

    def save(self, *args, **kwargs):
        self.log_activity(user=request.user, activity_type='created')
        super().save(*args, **kwargs)
```

### QR Code Generation

```python
from api.core.models import BarcodeBase

class MyModel(BarcodeBase, models.Model):
    qr_code_data = models.TextField(blank=True, null=True)

    @property
    def qr_code(self):
        if self.qr_code_data:
            return self.qr_code_data
        elif self.id:
            self.generate_and_store_qr_code()
            return self.qr_code_data
        return None
```

### Custom ViewSet Response

```python
def create(self, request, *args, **kwargs):
    serializer = self.get_serializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    obj = serializer.save()
    response_serializer = FullSerializer(obj)
    return Response(response_serializer.data, status=status.HTTP_201_CREATED)
```

---

## Task Completion Checklist

### Before Marking ANY Task Complete:

**1. Code Quality:**
- [ ] Code follows PEP 8 standards
- [ ] Django conventions followed
- [ ] No hardcoded values
- [ ] Proper error handling
- [ ] Security addressed

**2. Django-Specific:**
- [ ] Models changed? Run makemigrations + migrate
- [ ] New endpoints? Update URLs, test with JWT
- [ ] Serializers validate properly
- [ ] Permissions configured
- [ ] CORS settings updated if needed

**3. Testing (CRITICAL):**
- [ ] Run: `docker-compose exec web python manage.py test`
- [ ] ALL tests pass (0 failures)
- [ ] Test with existing data scenarios
- [ ] Test error cases

**4. Database Impact:**
- [ ] Migration files reviewed
- [ ] No destructive changes
- [ ] Backwards compatibility maintained
- [ ] Performance considered

**5. Final Verification:**
- [ ] Changes work with production data
- [ ] No breaking changes
- [ ] Docker logs clean

### Red Flags - STOP AND DISCUSS
- Deleting or renaming model fields
- Changing field types on existing data
- Removing API endpoints
- Changing authentication methods
- Major architectural changes

---

## Debugging Tips

### API Endpoint Not Found (404)

```python
docker-compose exec web python manage.py shell
>>> from django.urls import reverse
>>> reverse('harvestplan-list')
'/api/harvest-plans/'
```

### Frontend Getting 403/404

1. Is `X-ESK-VERSION: 1.0` header included?
2. Is JWT token valid and included?
3. Are URLs correct (no extra prefixes)?
4. Run API tests to verify endpoints work

### Test Failures

```bash
# Verbose output
docker-compose exec web python manage.py test api.tests.harvest --verbosity=2

# Fresh database
docker-compose exec web python manage.py test --noinput
```
