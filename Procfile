web: bash -c 'pnpm --filter @trendcart/db generate && pnpm --filter @trendcart/web start'
worker: bash -c 'pnpm --filter @trendcart/db generate && pnpm --filter @trendcart/worker start'
release: bash -c 'export DATABASE_URL="${DATABASE_URL}?sslmode=no-verify"; n=0; until pnpm --filter @trendcart/db migrate:deploy; do n=$((n+1)); if [ $n -ge 5 ]; then echo "release: migrate failed after $n attempts"; exit 1; fi; echo "release: migrate attempt $n failed (DB unreachable?) — retrying in 15s"; sleep 15; done'
