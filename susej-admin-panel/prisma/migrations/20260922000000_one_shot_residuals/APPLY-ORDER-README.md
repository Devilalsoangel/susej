# One-shot migrations — APPLY ORDER (read before touching prod)

These migrations are ADDITIVE (new nullable/defaulted columns + new tables)
but the deployed code reads the new columns unconditionally after this change
ships. Prisma enumerates model fields in every SELECT, so:

1. Neon backup first (Neon console → branch/restore point).
2. `prisma migrate deploy` against Neon (applies 20260922000000_*).
   Old code keeps running fine (it ignores the new columns).
3. THEN push/deploy the app (Vercel auto-deploys from main).
4. Verify: /api/v1/home 200-with-key, place a test order, wallet pull.

NEVER deploy step 3 before step 2 — new code on an old DB 503s every
order/dispute/withdrawal/seller read (unknown-column SELECTs).

`money-whole-rupee-STAGED-NOT-APPLIED.sql` is separate: needs its own
explicit call + backup (rewrites 15 live money tables).
