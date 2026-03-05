# WaterfallPay

**Instant gross-based waterfall revenue distribution engine for Stripe Connect.** Every payment automatically splits: tax reserve → ops reserve → sales commission to the closer → equity pool to all equity partners. Append-only ledger. Idempotency guard. Rounding sink. Fully configurable from a database table.

![WaterfallPay](https://img.shields.io/badge/WaterfallPay-v1-green?style=flat-square) ![Stripe](https://img.shields.io/badge/Stripe-Connect-635BFF?style=flat-square) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square)

---

## The Problem

Every startup with co-founders, equity partners, or a sales team needs to split revenue. Everyone writes it from scratch. Everyone gets rounding wrong. Everyone double-distributes on retries. Nobody audits it.

**WaterfallPay is the engine you write once and never touch again.**

---

## Default Waterfall

```
Gross Payment: $1,000
├── 25% Tax Reserve:      $250  → held in company account
├── 25% Ops Reserve:      $250  → held in company account
├── 10% Sales Commission: $100  → Stripe Connect transfer to closer
└── 40% Equity Pool:      $400  → split by equity % to each partner
    ├── Partner A (60%):  $240  → instant Stripe Connect transfer
    ├── Partner B (30%):  $120  → instant Stripe Connect transfer
    └── Partner C (10%):   $40  → instant Stripe Connect transfer
```

All percentages are configurable. Rounding delta goes to the designated sink partner.

---

## Features

- **Gross-based allocation** — all splits calculated from gross, not net
- **Idempotency guard** — same `payment_intent_id` never distributed twice
- **Rounding sink** — floating-point rounding delta assigned to one designated partner
- **Configurable from DB** — change percentages without a deploy
- **Append-only ledger** — every distribution immutably logged to `financial_ledger`
- **Instant transfers** — Stripe Connect transfers fired for each partner
- **Closer commission** — commission goes to the specific team member who closed the deal
- **Failed transfer handling** — partial failures tracked, logged, and retryable
- **Equity validation** — refuses to run if partner equity doesn't sum to exactly 100%

---

## Quick Start

```bash
git clone https://github.com/wilsonguenther-dev/WaterfallPay.git
cd WaterfallPay
npm install
cp .env.example .env.local
npm run dev
```

---

## Usage

```typescript
import { executeWaterfallDistribution } from "@/lib/waterfall-engine";

const result = await executeWaterfallDistribution(
  "pi_3ABC123",      // Stripe PaymentIntent ID (idempotency key)
  100000,             // gross amount in cents ($1,000.00)
  "usd",             // currency
  "team-member-id",  // closer (gets commission)
  2900,              // Stripe fee in cents
  { source: "course_purchase", courseId: "uuid" }
);

// result.equity_allocations = [
//   { member_name: "Alice", equity_percent: 60, amount_cents: 24000, transfer_id: "tr_..." },
//   { member_name: "Bob",   equity_percent: 40, amount_cents: 16000, transfer_id: "tr_..." },
// ]
```

---

## Database Schema

```sql
-- Waterfall configuration (admin-editable)
waterfall_config (config_key, config_value)
-- Keys: tax_percent, ops_percent, commission_percent, equity_pool_percent

-- Team members with equity
team_members (id, full_name, equity_percent, is_equity_partner,
              is_rounding_sink, stripe_connect_account_id,
              connect_payouts_enabled, is_active_member)

-- Immutable distribution records
waterfall_distributions (
  id, payment_id, payment_intent_id, gross_amount_cents,
  tax_amount_cents, ops_amount_cents, commission_amount_cents,
  equity_pool_cents, equity_allocations jsonb,
  closer_member_id, closer_name, status,
  rounding_delta_cents, rounding_sink_member_id,
  created_at, completed_at
)

-- Append-only financial ledger
financial_ledger (id, distribution_id, entry_type,
                  member_id, amount_cents, transfer_id,
                  metadata jsonb, created_at)
```

---

## Configuration

Update splits without deploying — just update the DB:

```sql
UPDATE waterfall_config SET config_value = '15' WHERE config_key = 'commission_percent';
UPDATE waterfall_config SET config_value = '35' WHERE config_key = 'equity_pool_percent';
```

---

## Adding an Equity Partner

```sql
INSERT INTO team_members (full_name, equity_percent, is_equity_partner, is_active_member,
                          stripe_connect_account_id, connect_payouts_enabled)
VALUES ('New Partner', 10.00, true, true, 'acct_XXXXXXXXX', true);

-- Remember: all equity_percent values must sum to 100
UPDATE team_members SET equity_percent = 50 WHERE full_name = 'Partner A';
UPDATE team_members SET equity_percent = 40 WHERE full_name = 'Partner B';
```

---

## Idempotency

If a distribution is triggered twice for the same `payment_intent_id` (e.g., webhook retry), WaterfallPay detects the existing record and returns the cached result without firing new transfers.

```typescript
// Safe to call multiple times — only executes once
await executeWaterfallDistribution("pi_3ABC123", 100000);
await executeWaterfallDistribution("pi_3ABC123", 100000); // no-op
```

---

## Stripe Webhook Integration

Wire up your Stripe webhook to trigger distributions automatically:

```typescript
// app/api/stripe/webhook/route.ts
if (event.type === "payment_intent.succeeded") {
  const pi = event.data.object;
  await executeWaterfallDistribution(
    pi.id,
    pi.amount,
    pi.currency,
    pi.metadata.closer_id,
    pi.latest_charge?.balance_transaction?.fee
  );
}
```

---

## Environment

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## License

MIT — Built by Wilson Guenther @ [Drivia Consulting](https://drivia.consulting)

---

## Support & Commercial Use

**This project is MIT licensed — free to use, modify, and ship.**

If it saves you time or makes you money:

- ⭐ **Star this repo** — it helps other developers find it
- 💼 **Need help integrating this?** [Book a call with Wilson](https://drivia.consulting) — custom implementation, enterprise support, or white-label licensing available
- ☕ **[Sponsor this project](https://github.com/sponsors/wilsonguenther-dev)** — keeps the open source work going

> Built at [Drivia](https://drivia.consulting) — AI-powered education infrastructure.

