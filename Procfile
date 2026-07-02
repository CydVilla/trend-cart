web: pnpm --filter @trendcart/web start
worker: pnpm --filter @trendcart/worker start
release: bash -c 'DATABASE_URL="${DATABASE_URL}?sslmode=no-verify" pnpm --filter @trendcart/db migrate:deploy'
