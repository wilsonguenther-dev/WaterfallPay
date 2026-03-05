import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key);
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );
}

async function verifyCfoAccess(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const supabase = getSupabase();
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

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
    return null;
  }
  return { user, profile, supabase };
}

// ─── GET: List operations (invoices, customers, products, disputes, payment links) ───
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyCfoAccess(req);
    if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const section = req.nextUrl.searchParams.get("section") || "";
    const stripe = getStripe();

    if (section === "invoices") {
      const status = req.nextUrl.searchParams.get("status") as Stripe.InvoiceListParams["status"] | null;
      const params: Stripe.InvoiceListParams = { limit: 50, expand: ["data.customer"] };
      if (status) params.status = status;
      const invoices = await stripe.invoices.list(params);
      return NextResponse.json({
        ok: true,
        invoices: invoices.data.map((inv) => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amount_due: inv.amount_due,
          amount_paid: inv.amount_paid,
          amount_remaining: inv.amount_remaining,
          currency: inv.currency,
          customer_email: (inv.customer as Stripe.Customer)?.email || inv.customer_email,
          customer_name: (inv.customer as Stripe.Customer)?.name || null,
          description: inv.description,
          due_date: inv.due_date,
          created: inv.created,
          hosted_invoice_url: inv.hosted_invoice_url,
          invoice_pdf: inv.invoice_pdf,
          paid: inv.status === "paid",
          collection_method: inv.collection_method,
          lines: inv.lines?.data?.map((line) => ({
            description: line.description,
            amount: line.amount,
            quantity: line.quantity,
          })) || [],
        })),
      });
    }

    if (section === "customers") {
      const customers = await stripe.customers.list({ limit: 100, expand: ["data.subscriptions"] });
      return NextResponse.json({
        ok: true,
        customers: customers.data.map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          created: c.created,
          balance: c.balance,
          currency: c.currency,
          metadata: c.metadata,
          subscriptions: (c as any).subscriptions?.data?.length || 0,
        })),
      });
    }

    if (section === "products") {
      const [products, prices] = await Promise.all([
        stripe.products.list({ limit: 50, active: true }),
        stripe.prices.list({ limit: 100, active: true }),
      ]);
      return NextResponse.json({
        ok: true,
        products: products.data.map((p) => {
          const pPrices = prices.data.filter((pr) => {
            const prod = pr.product;
            return typeof prod === "string" ? prod === p.id : prod?.id === p.id;
          });
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            active: p.active,
            created: p.created,
            images: p.images,
            metadata: p.metadata,
            prices: pPrices.map((pr) => ({
              id: pr.id,
              unit_amount: pr.unit_amount,
              currency: pr.currency,
              recurring: pr.recurring,
              type: pr.type,
            })),
          };
        }),
      });
    }

    if (section === "disputes") {
      const disputes = await stripe.disputes.list({ limit: 30 });
      return NextResponse.json({
        ok: true,
        disputes: disputes.data.map((d) => ({
          id: d.id,
          amount: d.amount,
          currency: d.currency,
          status: d.status,
          reason: d.reason,
          created: d.created,
          evidence_due_by: (d.evidence_details as any)?.due_by || null,
        })),
      });
    }

    if (section === "payment-links") {
      const links = await stripe.paymentLinks.list({ limit: 30 });
      return NextResponse.json({
        ok: true,
        links: links.data.map((l) => ({
          id: l.id,
          url: l.url,
          active: l.active,
          metadata: l.metadata,
        })),
      });
    }

    if (section === "refunds") {
      const refunds = await stripe.refunds.list({ limit: 30, expand: ["data.charge"] });
      return NextResponse.json({
        ok: true,
        refunds: refunds.data.map((r) => ({
          id: r.id,
          amount: r.amount,
          currency: r.currency,
          status: r.status,
          reason: r.reason,
          created: r.created,
          charge_id: typeof r.charge === "string" ? r.charge : r.charge?.id,
        })),
      });
    }

    if (section === "coupons") {
      const coupons = await stripe.coupons.list({ limit: 30 });
      return NextResponse.json({
        ok: true,
        coupons: coupons.data.map((c) => ({
          id: c.id,
          name: c.name,
          percent_off: c.percent_off,
          amount_off: c.amount_off,
          currency: c.currency,
          duration: c.duration,
          times_redeemed: c.times_redeemed,
          valid: c.valid,
          created: c.created,
        })),
      });
    }

    if (section === "subscriptions") {
      const subs = await stripe.subscriptions.list({ limit: 50, expand: ["data.customer", "data.items.data.price"] });
      return NextResponse.json({
        ok: true,
        subscriptions: subs.data.map((s) => ({
          id: s.id,
          status: s.status,
          customer_email: (s.customer as Stripe.Customer)?.email || null,
          customer_name: (s.customer as Stripe.Customer)?.name || null,
          created: s.created,
          current_period_end: (s as any).current_period_end,
          cancel_at_period_end: s.cancel_at_period_end,
          items: s.items.data.map((i) => ({
            price_id: i.price.id,
            amount: i.price.unit_amount,
            currency: i.price.currency,
            interval: i.price.recurring?.interval,
            product: typeof i.price.product === "string" ? i.price.product : (i.price.product as Stripe.Product)?.name,
          })),
        })),
      });
    }

    if (section === "balance-transactions") {
      const txns = await stripe.balanceTransactions.list({ limit: 50 });
      return NextResponse.json({
        ok: true,
        transactions: txns.data.map((t) => ({
          id: t.id,
          amount: t.amount,
          fee: t.fee,
          net: t.net,
          currency: t.currency,
          type: t.type,
          description: t.description,
          created: t.created,
          status: t.status,
        })),
      });
    }

    return NextResponse.json({ error: "Unknown section" }, { status: 400 });
  } catch (err: any) {
    console.error("[CFO Ops GET]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST: Create/action operations ───
export async function POST(req: NextRequest) {
  try {
    const auth = await verifyCfoAccess(req);
    if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { action } = body;
    const stripe = getStripe();

    // ── Create Customer ──
    if (action === "create-customer") {
      const { name, email, phone, metadata } = body;
      if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

      const customer = await stripe.customers.create({
        name: name || undefined,
        email,
        phone: phone || undefined,
        metadata: metadata || {},
      });

      // Update user_profiles if matching email
      await auth.supabase
        .from("user_profiles")
        .update({ stripe_customer_id: customer.id })
        .eq("email", email)
        .is("stripe_customer_id", null);

      return NextResponse.json({ ok: true, customer: { id: customer.id, name: customer.name, email: customer.email } });
    }

    // ── Create Invoice ──
    if (action === "create-invoice") {
      const { customer_id, items, due_days, description, collection_method, send_immediately } = body;
      if (!customer_id || !items?.length) {
        return NextResponse.json({ error: "customer_id and items[] required" }, { status: 400 });
      }

      // Create invoice
      const invoiceParams: Stripe.InvoiceCreateParams = {
        customer: customer_id,
        collection_method: collection_method || "send_invoice",
        description: description || undefined,
      };
      if (invoiceParams.collection_method === "send_invoice") {
        invoiceParams.days_until_due = due_days || 30;
      }
      const invoice = await stripe.invoices.create(invoiceParams);

      // Add line items
      for (const item of items) {
        await stripe.invoiceItems.create({
          customer: customer_id,
          invoice: invoice.id,
          amount: Math.round(item.amount_cents),
          currency: item.currency || "usd",
          description: item.description || "Line item",
        });
      }

      // Finalize
      const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

      // Send immediately if requested
      if (send_immediately && finalized.collection_method === "send_invoice") {
        await stripe.invoices.sendInvoice(invoice.id);
      }

      // Log in Supabase
      try {
        await auth.supabase.from("cfo_audit_log").insert({
          action: "invoice_created",
          details: { invoice_id: invoice.id, customer_id, amount: items.reduce((s: number, i: any) => s + i.amount_cents, 0), description },
          performed_by: auth.user.id,
        });
      } catch (_) { /* audit log is best-effort */ }

      return NextResponse.json({
        ok: true,
        invoice: {
          id: finalized.id,
          number: finalized.number,
          status: finalized.status,
          amount_due: finalized.amount_due,
          hosted_invoice_url: finalized.hosted_invoice_url,
          invoice_pdf: finalized.invoice_pdf,
        },
      });
    }

    // ── Send Invoice ──
    if (action === "send-invoice") {
      const { invoice_id } = body;
      if (!invoice_id) return NextResponse.json({ error: "invoice_id required" }, { status: 400 });
      const sent = await stripe.invoices.sendInvoice(invoice_id);
      return NextResponse.json({ ok: true, status: sent.status });
    }

    // ── Void Invoice ──
    if (action === "void-invoice") {
      const { invoice_id } = body;
      if (!invoice_id) return NextResponse.json({ error: "invoice_id required" }, { status: 400 });
      const voided = await stripe.invoices.voidInvoice(invoice_id);
      return NextResponse.json({ ok: true, status: voided.status });
    }

    // ── Create Credit Note ──
    if (action === "create-credit-note") {
      const { invoice_id, amount, reason } = body;
      if (!invoice_id) return NextResponse.json({ error: "invoice_id required" }, { status: 400 });
      const params: Stripe.CreditNoteCreateParams = { invoice: invoice_id };
      if (amount) params.lines = [{ type: "custom_line_item", unit_amount: amount, quantity: 1, description: reason || "Credit" }];
      const note = await stripe.creditNotes.create(params);
      return NextResponse.json({ ok: true, credit_note: { id: note.id, amount: note.amount, status: note.status } });
    }

    // ── Issue Refund ──
    if (action === "create-refund") {
      const { payment_intent_id, charge_id, amount, reason } = body;
      if (!payment_intent_id && !charge_id) {
        return NextResponse.json({ error: "payment_intent_id or charge_id required" }, { status: 400 });
      }
      const params: Stripe.RefundCreateParams = {};
      if (payment_intent_id) params.payment_intent = payment_intent_id;
      if (charge_id) params.charge = charge_id;
      if (amount) params.amount = amount;
      if (reason) params.reason = reason as Stripe.RefundCreateParams.Reason;
      const refund = await stripe.refunds.create(params);
      return NextResponse.json({ ok: true, refund: { id: refund.id, amount: refund.amount, status: refund.status } });
    }

    // ── Create Product ──
    if (action === "create-product") {
      const { name, description: desc, price_cents, currency, recurring_interval } = body;
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      const product = await stripe.products.create({ name, description: desc || undefined });
      let price = null;
      if (price_cents) {
        const priceParams: Stripe.PriceCreateParams = {
          product: product.id,
          unit_amount: price_cents,
          currency: currency || "usd",
        };
        if (recurring_interval) {
          priceParams.recurring = { interval: recurring_interval };
        }
        price = await stripe.prices.create(priceParams);
      }
      return NextResponse.json({ ok: true, product: { id: product.id, name: product.name }, price: price ? { id: price.id, amount: price.unit_amount } : null });
    }

    // ── Create Payment Link ──
    if (action === "create-payment-link") {
      const { price_id, quantity } = body;
      if (!price_id) return NextResponse.json({ error: "price_id required" }, { status: 400 });
      const link = await stripe.paymentLinks.create({
        line_items: [{ price: price_id, quantity: quantity || 1 }],
      });
      return NextResponse.json({ ok: true, link: { id: link.id, url: link.url } });
    }

    // ── Create Coupon ──
    if (action === "create-coupon") {
      const { name, percent_off, amount_off, currency, duration, duration_in_months } = body;
      const params: any = { name: name || undefined, duration: duration || "once" };
      if (percent_off) params.percent_off = percent_off;
      else if (amount_off) { params.amount_off = amount_off; params.currency = currency || "usd"; }
      if (duration === "repeating" && duration_in_months) params.duration_in_months = duration_in_months;
      const coupon = await stripe.coupons.create(params);
      return NextResponse.json({ ok: true, coupon: { id: coupon.id, name: coupon.name, valid: coupon.valid } });
    }

    // ── Cancel Subscription ──
    if (action === "cancel-subscription") {
      const { subscription_id, at_period_end } = body;
      if (!subscription_id) return NextResponse.json({ error: "subscription_id required" }, { status: 400 });
      if (at_period_end) {
        const updated = await stripe.subscriptions.update(subscription_id, { cancel_at_period_end: true });
        return NextResponse.json({ ok: true, status: updated.status, cancel_at_period_end: true });
      }
      const canceled = await stripe.subscriptions.cancel(subscription_id);
      return NextResponse.json({ ok: true, status: canceled.status });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("[CFO Ops POST]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
