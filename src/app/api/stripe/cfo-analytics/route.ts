import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key, { apiVersion: "2024-12-18.acacia" as any });
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );
}

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabase();
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Verify CFO access
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("role")
      .eq("auth_id", user.id)
      .single();

    const isCfoDelegate = await supabase
      .from("cfo_delegates")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (!["super_admin", "org_admin"].includes(profile?.role || "") && !isCfoDelegate.data) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const section = req.nextUrl.searchParams.get("section") || "overview";

    if (section === "overview") {
      return NextResponse.json(await getOverview());
    } else if (section === "balance") {
      return NextResponse.json(await getBalance());
    } else if (section === "tax") {
      return NextResponse.json(await getTaxData());
    } else if (section === "customers") {
      return NextResponse.json(await getCustomerMetrics());
    } else if (section === "payouts") {
      return NextResponse.json(await getPayouts());
    } else if (section === "revenue-trend") {
      return NextResponse.json(await getRevenueTrend());
    } else if (section === "charges") {
      return NextResponse.json(await getRecentCharges());
    } else {
      return NextResponse.json({ error: "Unknown section" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("[CFO Analytics]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function getOverview() {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false, error: "Stripe not configured" };

  const stripe = getStripe();
  const [balance, charges30d, chargesAll] = await Promise.all([
    stripe.balance.retrieve(),
    stripe.charges.list({ limit: 100, created: { gte: Math.floor(Date.now() / 1000) - 30 * 86400 } }),
    stripe.charges.list({ limit: 100 }),
  ]);

  const available = balance.available.reduce((s: number, b: any) => s + b.amount, 0);
  const pending = balance.pending.reduce((s: number, b: any) => s + b.amount, 0);

  const succeeded30d = charges30d.data.filter((c: any) => c.status === "succeeded");
  const revenue30d = succeeded30d.reduce((s: number, c: any) => s + c.amount, 0);
  const refunds30d = charges30d.data.filter((c: any) => c.refunded).length;

  const succeededAll = chargesAll.data.filter((c: any) => c.status === "succeeded");
  const revenueAll = succeededAll.reduce((s: number, c: any) => s + c.amount, 0);

  return {
    ok: true,
    balance: { available, pending, total: available + pending, currency: "usd" },
    revenue30d,
    revenueAll,
    transactions30d: succeeded30d.length,
    transactionsAll: succeededAll.length,
    avgTransaction: succeeded30d.length > 0 ? Math.round(revenue30d / succeeded30d.length) : 0,
    refunds30d,
  };
}

async function getBalance() {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false };
  const stripe = getStripe();
  const balance = await stripe.balance.retrieve();
  return {
    ok: true,
    available: balance.available.map((b: any) => ({ amount: b.amount, currency: b.currency })),
    pending: balance.pending.map((b: any) => ({ amount: b.amount, currency: b.currency })),
  };
}

async function getTaxData() {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false };
  const stripe = getStripe();
  const charges = await stripe.charges.list({ limit: 100, expand: ["data.balance_transaction"] });
  const succeeded = charges.data.filter((c: any) => c.status === "succeeded");

  let totalGross = 0;
  let totalFees = 0;
  let totalNet = 0;

  for (const c of succeeded) {
    totalGross += c.amount;
    const bt = c.balance_transaction as Stripe.BalanceTransaction | null;
    if (bt && typeof bt === "object") {
      totalFees += bt.fee;
      totalNet += bt.net;
    }
  }

  // Estimated tax obligations (simplified)
  const estimatedFederalTax = Math.round(totalNet * 0.21); // 21% corporate
  const estimatedStateTax = Math.round(totalNet * 0.065); // ~6.5% avg state
  const estimatedSelfEmployment = Math.round(totalNet * 0.153); // 15.3% SE tax

  return {
    ok: true,
    totalGross,
    totalFees,
    totalNet,
    stripeFeeRate: totalGross > 0 ? ((totalFees / totalGross) * 100).toFixed(2) : "0",
    taxEstimates: {
      federalIncome: estimatedFederalTax,
      stateIncome: estimatedStateTax,
      selfEmployment: estimatedSelfEmployment,
      totalEstimated: estimatedFederalTax + estimatedStateTax + estimatedSelfEmployment,
    },
    profitMargin: totalGross > 0 ? ((totalNet / totalGross) * 100).toFixed(1) : "0",
  };
}

async function getCustomerMetrics() {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false };
  const stripe = getStripe();
  const [customers, subs] = await Promise.all([
    stripe.customers.list({ limit: 100 }),
    stripe.subscriptions.list({ limit: 100, status: "active" }),
  ]);

  const totalCustomers = customers.data.length;
  const activeSubscribers = subs.data.length;
  const mrr = subs.data.reduce((s: number, sub: any) => {
    const item = sub.items.data[0];
    if (!item?.price?.unit_amount) return s;
    const interval = item.price.recurring?.interval;
    if (interval === "month") return s + item.price.unit_amount;
    if (interval === "year") return s + Math.round(item.price.unit_amount / 12);
    return s;
  }, 0);

  const arr = mrr * 12;
  const avgRevenuePerCustomer = totalCustomers > 0 ? Math.round(mrr / totalCustomers) : 0;

  return {
    ok: true,
    totalCustomers,
    activeSubscribers,
    mrr,
    arr,
    avgRevenuePerCustomer,
    churnRate: 0, // Would need historical data
  };
}

async function getPayouts() {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false };
  const stripe = getStripe();
  const payouts = await stripe.payouts.list({ limit: 20 });
  return {
    ok: true,
    payouts: payouts.data.map((p: any) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      arrival_date: p.arrival_date,
      created: p.created,
      method: p.method,
    })),
  };
}

async function getRevenueTrend() {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false };
  const stripe = getStripe();
  const now = Math.floor(Date.now() / 1000);
  const charges = await stripe.charges.list({
    limit: 100,
    created: { gte: now - 365 * 86400 },
  });

  const monthlyData: Record<string, { revenue: number; count: number; fees: number }> = {};

  for (const c of charges.data) {
    if (c.status !== "succeeded") continue;
    const date = new Date(c.created * 1000);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyData[key]) monthlyData[key] = { revenue: 0, count: 0, fees: 0 };
    monthlyData[key].revenue += c.amount;
    monthlyData[key].count++;
  }

  // Sort by month
  const sorted = Object.entries(monthlyData)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, data]) => ({ month, ...data }));

  return { ok: true, trend: sorted };
}

async function getRecentCharges() {
  if (!process.env.STRIPE_SECRET_KEY) return { ok: false };
  const stripe = getStripe();
  const charges = await stripe.charges.list({ limit: 30, expand: ["data.customer"] });
  return {
    ok: true,
    charges: charges.data.map((c: any) => ({
      id: c.id,
      amount: c.amount,
      currency: c.currency,
      status: c.status,
      created: c.created,
      description: c.description,
      customerEmail: (c.customer as Stripe.Customer)?.email || c.receipt_email || null,
      refunded: c.refunded,
    })),
  };
}
