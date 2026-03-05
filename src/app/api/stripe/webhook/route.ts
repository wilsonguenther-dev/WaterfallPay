import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@supabase/supabase-js";
import { sendPaymentReceiptEmail, sendSubscriptionCanceledEmail, sendInvoiceEmail } from "@/lib/resend";
import { executeWaterfallDistribution, reverseWaterfallDistribution } from "@/lib/waterfall-engine";
import Stripe from "stripe";

// Use service role client for webhook processing (no user context)
function getAdminSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[Stripe Webhook] STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("[Stripe Webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = getAdminSupabase();

  // Idempotency: check if we already processed this event
  const { data: existing } = await supabase
    .from("stripe_webhook_events")
    .select("id")
    .eq("stripe_event_id", event.id)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ received: true, status: "already_processed" });
  }

  // Log the event
  await supabase.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    payload: event.data.object as any,
  });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutComplete(supabase, session);
        break;
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(supabase, subscription);
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(supabase, subscription);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(supabase, invoice);
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(supabase, invoice);
        break;
      }
      case "invoice.finalized": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoiceFinalized(supabase, invoice);
        break;
      }
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await handlePaymentIntentSucceeded(supabase, paymentIntent);
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        await handleChargeRefunded(supabase, charge);
        break;
      }
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        await handleDisputeCreated(supabase, dispute);
        break;
      }
    }

    // Mark as processed
    await supabase
      .from("stripe_webhook_events")
      .update({ processed: true })
      .eq("stripe_event_id", event.id);

  } catch (err) {
    console.error(`[Stripe Webhook] Error processing ${event.type}:`, err);
    await supabase
      .from("stripe_webhook_events")
      .update({ error: (err as Error).message })
      .eq("stripe_event_id", event.id);
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutComplete(supabase: any, session: Stripe.Checkout.Session) {
  const userId = session.metadata?.drivia_user_id;
  const plan = session.metadata?.plan;
  if (!userId || !plan) return;

  // Get user for email
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id, email, display_name, stripe_customer_id")
    .eq("id", userId)
    .single();

  // Save stripe_customer_id to user_profiles if not already set
  // This ensures the user appears in Stripe's customer list and
  // future subscription webhooks can find them by customer ID
  if (session.customer && profile && !profile.stripe_customer_id) {
    await supabase
      .from("user_profiles")
      .update({ stripe_customer_id: session.customer as string })
      .eq("id", userId);
  }

  if (session.mode === "payment") {
    // One-time payment (founder or course purchase)
    await supabase.from("payments").insert({
      user_id: userId,
      stripe_payment_intent_id: session.payment_intent as string,
      stripe_checkout_session_id: session.id,
      amount: session.amount_total || 0,
      currency: session.currency || "usd",
      status: "succeeded",
      type: plan === "founder" ? "founder" : plan === "course" ? "course_purchase" : "one_time",
      description: plan === "founder" ? "Founders Lifetime Access" : `Course purchase`,
      metadata: session.metadata as any,
    });

    if (plan === "balance_payment" && session.metadata?.payment_plan_id) {
      // Partial payment against a payment plan
      const planId = session.metadata.payment_plan_id;
      const paidCents = session.amount_total || 0;

      // Record line item
      const { data: paymentRow } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_payment_intent_id", session.payment_intent as string)
        .single();

      await supabase.from("payment_plan_payments").insert({
        payment_plan_id: planId,
        payment_id: paymentRow?.id || null,
        amount_cents: paidCents,
        payment_method: "stripe",
        note: `Stripe payment — $${(paidCents / 100).toFixed(2)}`,
      });

      // Update the plan's paid amount
      const { data: currentPlan } = await supabase
        .from("payment_plans")
        .select("paid_amount_cents, total_amount_cents, user_id")
        .eq("id", planId)
        .single();

      if (currentPlan) {
        const newPaid = currentPlan.paid_amount_cents + paidCents;
        const isComplete = newPaid >= currentPlan.total_amount_cents;

        await supabase
          .from("payment_plans")
          .update({
            paid_amount_cents: newPaid,
            status: isComplete ? "completed" : "active",
            updated_at: new Date().toISOString(),
          })
          .eq("id", planId);

        // Send notification
        const remaining = currentPlan.total_amount_cents - newPaid;
        const { data: planUser } = await supabase
          .from("user_profiles")
          .select("id")
          .eq("auth_id", currentPlan.user_id)
          .single();

        if (planUser) {
          await supabase.from("notifications").insert({
            user_id: planUser.id,
            type: "payment",
            title: isComplete
              ? "Balance Paid in Full!"
              : `Payment Received — $${(remaining / 100).toFixed(2)} remaining`,
            body: isComplete
              ? `Your balance has been paid in full. Thank you!`
              : `We received your payment of $${(paidCents / 100).toFixed(2)}. Remaining balance: $${(remaining / 100).toFixed(2)}.`,
            link: "/dashboard/account",
          });
        }
      }
    }

    if (plan === "founder") {
      // Update user tier
      await supabase
        .from("user_profiles")
        .update({ subscription_tier: "founder" })
        .eq("id", userId);

      // Create subscription record (lifetime = no end date)
      await supabase.from("subscriptions").insert({
        user_id: userId,
        stripe_customer_id: session.customer as string,
        plan: "founder",
        status: "active",
        current_period_start: new Date().toISOString(),
        metadata: { founder_slot: session.metadata?.founder_slot },
      });

      // Increment founder counter
      await supabase.rpc("increment_founder_slots");
    }

    if (plan === "course" && session.metadata?.course_id) {
      // Record course purchase
      await supabase.from("course_purchases").insert({
        user_id: userId,
        learning_path_id: session.metadata.course_id,
        price: session.amount_total || 0,
      }).onConflict("user_id,learning_path_id").ignore();

      // Auto-enroll in the course
      await supabase.from("course_enrollments").upsert({
        user_id: userId,
        learning_path_id: session.metadata.course_id,
        status: "active",
      }, { onConflict: "user_id,learning_path_id" });
    }

    // Send receipt email
    if (profile?.email) {
      await sendPaymentReceiptEmail(
        profile.email,
        profile.display_name || "Learner",
        session.amount_total || 0,
        plan
      );
    }

    // Track affiliate referral commission
    await trackAffiliateCommission(supabase, session, userId);

    // Track sales agent commission if discount code was used
    await trackSalesAgentCommission(supabase, session, userId);
  }

  if (session.mode === "subscription") {
    // Subscription created — will be handled by customer.subscription.updated
    // Just update the tier immediately
    await supabase
      .from("user_profiles")
      .update({ subscription_tier: plan })
      .eq("id", userId);

    if (profile?.email) {
      await sendPaymentReceiptEmail(
        profile.email,
        profile.display_name || "Learner",
        session.amount_total || 0,
        plan
      );
    }

    // Track affiliate referral commission for subscriptions too
    await trackAffiliateCommission(supabase, session, userId);

    // Track sales agent commission for subscriptions too
    await trackSalesAgentCommission(supabase, session, userId);
  }
}

async function handleSubscriptionUpdated(supabase: any, subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  // Find user by stripe_customer_id
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  if (!profile) return;

  const plan = subscription.items.data[0]?.price?.recurring?.interval === "year" ? "annual" : "monthly";
  const status = subscription.status === "active" ? "active"
    : subscription.status === "past_due" ? "past_due"
    : subscription.status === "canceled" ? "canceled"
    : subscription.status === "trialing" ? "trialing"
    : subscription.status === "incomplete" ? "incomplete"
    : "paused";

  // Upsert subscription record
  await supabase.from("subscriptions").upsert({
    user_id: profile.id,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: customerId,
    plan,
    status,
    current_period_start: new Date(((subscription as any).current_period_start || 0) * 1000).toISOString(),
    current_period_end: new Date(((subscription as any).current_period_end || 0) * 1000).toISOString(),
    cancel_at: (subscription as any).cancel_at ? new Date((subscription as any).cancel_at * 1000).toISOString() : null,
    canceled_at: (subscription as any).canceled_at ? new Date((subscription as any).canceled_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "stripe_subscription_id" });

  // Update user tier
  const tier = status === "active" || status === "trialing" ? plan : "free";
  await supabase
    .from("user_profiles")
    .update({ subscription_tier: tier })
    .eq("id", profile.id);
}

async function handleSubscriptionDeleted(supabase: any, subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id, email, display_name, subscription_tier")
    .eq("stripe_customer_id", customerId)
    .single();
  if (!profile) return;

  // Don't downgrade founders
  if (profile.subscription_tier === "founder") return;

  // Mark subscription as canceled
  await supabase
    .from("subscriptions")
    .update({ status: "canceled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", subscription.id);

  // Downgrade user to free
  await supabase
    .from("user_profiles")
    .update({ subscription_tier: "free" })
    .eq("id", profile.id);

  // Send cancellation email
  if (profile.email) {
    const endDate = new Date(((subscription as any).current_period_end || 0) * 1000).toLocaleDateString();
    await sendSubscriptionCanceledEmail(profile.email, profile.display_name || "Learner", endDate);
  }
}

async function handlePaymentFailed(supabase: any, invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;
  const subscriptionId = (invoice as any).subscription as string;

  if (subscriptionId) {
    await supabase
      .from("subscriptions")
      .update({ status: "past_due", updated_at: new Date().toISOString() })
      .eq("stripe_subscription_id", subscriptionId);
  }

  // Update user tier to reflect past_due
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id, subscription_tier")
    .eq("stripe_customer_id", customerId)
    .single();

  if (profile && profile.subscription_tier !== "founder") {
    await supabase
      .from("user_profiles")
      .update({ subscription_tier: "free" })
      .eq("id", profile.id);
  }
}

async function handleInvoiceFinalized(supabase: any, invoice: Stripe.Invoice) {
  // Send branded invoice email via Resend instead of Stripe's default
  if (!invoice.customer_email && !invoice.customer) return;

  const email = invoice.customer_email || "";
  let name = "Customer";

  // Try to get customer name from our DB
  if (invoice.customer) {
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("display_name, email")
      .eq("stripe_customer_id", invoice.customer as string)
      .maybeSingle();

    if (profile) {
      name = profile.display_name || "Customer";
      if (!email && profile.email) {
        // Use profile email if Stripe doesn't have one
      }
    }
  }

  const toEmail = email || (invoice.customer_email as string);
  if (!toEmail) return;

  // Build line items from invoice
  const lineItems = ((invoice as any).lines?.data || []).map((line: any) => ({
    description: line.description || "Invoice item",
    amount: line.amount || 0,
  }));

  const dueDate = invoice.due_date
    ? new Date(invoice.due_date * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "Upon receipt";

  await sendInvoiceEmail({
    to: toEmail,
    name,
    invoiceNumber: invoice.number || invoice.id,
    amountDue: invoice.amount_due || 0,
    dueDate,
    memo: invoice.description || undefined,
    lineItems: lineItems.length > 0 ? lineItems : undefined,
    hostedUrl: invoice.hosted_invoice_url || `https://dashboard.stripe.com/invoices/${invoice.id}`,
    pdfUrl: invoice.invoice_pdf || undefined,
  });

  console.log(`[Stripe Webhook] Invoice ${invoice.number} email sent via Resend to ${toEmail}`);
}

async function handleInvoicePaid(supabase: any, invoice: Stripe.Invoice) {
  if (!(invoice as any).payment_intent) return;

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id")
    .eq("stripe_customer_id", invoice.customer as string)
    .single();
  if (!profile) return;

  await supabase.from("payments").upsert({
    user_id: profile.id,
    stripe_payment_intent_id: (invoice as any).payment_intent as string,
    amount: invoice.amount_paid || 0,
    currency: invoice.currency || "usd",
    status: "succeeded",
    type: "subscription",
    description: `Invoice ${invoice.number || invoice.id}`,
  }, { onConflict: "stripe_payment_intent_id" });
}

async function trackAffiliateCommission(supabase: any, session: Stripe.Checkout.Session, userId: string) {
  const referralCode = session.metadata?.referral_code;
  if (!referralCode) return;

  try {
    // Look up the affiliate by code
    const { data: affiliate } = await supabase
      .from("affiliates")
      .select("id, commission_rate, user_id, is_active")
      .eq("affiliate_code", referralCode)
      .eq("is_active", true)
      .single();

    if (!affiliate) return;

    // Don't allow self-referrals
    if (affiliate.user_id === userId) return;

    const amount = session.amount_total || 0;
    const commissionRate = affiliate.commission_rate || 20;
    const commission = Math.round(amount * (commissionRate / 100));

    // Create referral record
    await supabase.from("affiliate_referrals").insert({
      affiliate_id: affiliate.id,
      referred_user_id: userId,
      learning_path_id: session.metadata?.course_id || null,
      status: "converted",
      amount,
      commission,
    });

    // Update affiliate totals
    await supabase.rpc("increment_affiliate_stats", {
      p_affiliate_id: affiliate.id,
      p_earnings: commission,
    }).then(() => {}).catch(() => {
      // Fallback: manual update if RPC doesn't exist
      supabase
        .from("affiliates")
        .update({
          total_referrals: affiliate.total_referrals + 1,
          total_earnings: (affiliate.total_earnings || 0) + commission / 100,
        })
        .eq("id", affiliate.id);
    });

    // Link user to affiliate
    await supabase
      .from("user_profiles")
      .update({ referred_by: affiliate.id })
      .eq("id", userId);

    console.log(`[Stripe Webhook] Affiliate ${referralCode} credited $${(commission / 100).toFixed(2)} for referral of ${userId}`);
  } catch (err) {
    console.error("[Stripe Webhook] Affiliate tracking error:", err);
  }
}

async function trackSalesAgentCommission(supabase: any, session: Stripe.Checkout.Session, userId: string) {
  try {
    // Check if a promotion code / discount was applied
    if (!session.total_details?.breakdown?.discounts?.length) return;

    for (const discount of session.total_details.breakdown.discounts) {
      const promoCodeId = (discount as any).discount?.promotion_code;
      if (!promoCodeId) continue;

      // Look up which discount_code record has this stripe_promo_code_id
      const { data: discountCode } = await supabase
        .from("discount_codes")
        .select("id, code, sales_agent_id")
        .eq("stripe_promo_code_id", promoCodeId)
        .single();

      if (!discountCode?.sales_agent_id) continue;

      // Get the sales agent
      const { data: agent } = await supabase
        .from("sales_agents")
        .select("id, user_id, commission_rate, total_sales_count, total_sales_amount_cents, total_commission_cents")
        .eq("id", discountCode.sales_agent_id)
        .eq("is_active", true)
        .single();

      if (!agent) continue;

      const grossAmount = session.amount_total || 0;
      const commissionRate = agent.commission_rate || 20;
      const commissionCents = Math.round(grossAmount * (commissionRate / 100));
      const plan = session.metadata?.plan || "unknown";

      // Record the sales transaction
      await supabase.from("sales_transactions").insert({
        sales_agent_id: agent.id,
        buyer_user_id: userId,
        discount_code_id: discountCode.id,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent as string || null,
        plan,
        gross_amount_cents: grossAmount,
        discount_amount_cents: 0,
        net_amount_cents: grossAmount,
        commission_rate: commissionRate,
        commission_cents: commissionCents,
        payout_status: "pending",
      });

      // Update agent totals
      await supabase
        .from("sales_agents")
        .update({
          total_sales_count: (agent.total_sales_count || 0) + 1,
          total_sales_amount_cents: (agent.total_sales_amount_cents || 0) + grossAmount,
          total_commission_cents: (agent.total_commission_cents || 0) + commissionCents,
          updated_at: new Date().toISOString(),
        })
        .eq("id", agent.id);

      console.log(`[Stripe Webhook] Sales agent ${agent.id} credited $${(commissionCents / 100).toFixed(2)} for sale via code ${discountCode.code}`);
    }
  } catch (err) {
    console.error("[Stripe Webhook] Sales agent tracking error:", err);
  }
}

// ══════════════════════════════════════════════════════════════
// WATERFALL DISTRIBUTION HANDLERS
// ══════════════════════════════════════════════════════════════

async function handlePaymentIntentSucceeded(supabase: any, paymentIntent: Stripe.PaymentIntent) {
  const piId = paymentIntent.id;
  const grossCents = paymentIntent.amount;
  const currency = paymentIntent.currency || "usd";

  // Skip zero-amount or test payments
  if (grossCents <= 0) return;

  // Determine closer from metadata (set during checkout creation)
  const closerMemberId = paymentIntent.metadata?.closer_member_id || null;

  // Get Stripe fee from the latest charge
  let stripFeeCents = 0;
  try {
    const stripe = getStripe();
    const charges = paymentIntent.latest_charge
      ? [await stripe.charges.retrieve(paymentIntent.latest_charge as string, { expand: ["balance_transaction"] })]
      : [];
    if (charges[0]?.balance_transaction && typeof charges[0].balance_transaction !== "string") {
      stripFeeCents = (charges[0].balance_transaction as any).fee || 0;
    }
  } catch (err) {
    console.warn("[Waterfall] Could not retrieve Stripe fee:", err);
  }

  // Execute waterfall distribution
  const result = await executeWaterfallDistribution(
    piId,
    grossCents,
    currency,
    closerMemberId,
    stripFeeCents,
    {
      customer: paymentIntent.customer,
      description: paymentIntent.description,
      metadata: paymentIntent.metadata,
    }
  );

  if (result.errors.length > 0) {
    console.warn(`[Waterfall] Distribution for PI:${piId} completed with ${result.errors.length} warnings:`, result.errors);
  }

  console.log(
    `[Waterfall] PI:${piId} — $${(grossCents / 100).toFixed(2)} distributed:`,
    `Tax=$${(result.tax_amount_cents / 100).toFixed(2)}`,
    `Ops=$${(result.ops_amount_cents / 100).toFixed(2)}`,
    `Commission=$${(result.commission_amount_cents / 100).toFixed(2)}`,
    `Equity=$${(result.equity_pool_cents / 100).toFixed(2)}`,
    `Status=${result.success ? "OK" : "PARTIAL"}`
  );
}

async function handleChargeRefunded(supabase: any, charge: Stripe.Charge) {
  const paymentIntentId = charge.payment_intent as string;
  if (!paymentIntentId) return;

  const refundedAmount = charge.amount_refunded || 0;
  if (refundedAmount <= 0) return;

  // Get the refund ID from the latest refund
  const latestRefund = (charge.refunds?.data || [])[0];
  const stripeRefundId = latestRefund?.id;

  const result = await reverseWaterfallDistribution(
    paymentIntentId,
    refundedAmount,
    "refund",
    stripeRefundId
  );

  if (!result.success) {
    console.error(`[Waterfall] Refund reversal failed for PI:${paymentIntentId}:`, result.errors);
  } else {
    console.log(`[Waterfall] Refund reversal for PI:${paymentIntentId} — $${(refundedAmount / 100).toFixed(2)}`);
  }
}

async function handleDisputeCreated(supabase: any, dispute: Stripe.Dispute) {
  const charge = dispute.charge;
  const chargeId = typeof charge === "string" ? charge : charge?.id;
  if (!chargeId) return;

  // Retrieve the charge to get payment_intent_id
  try {
    const stripe = getStripe();
    const fullCharge = await stripe.charges.retrieve(chargeId);
    const paymentIntentId = fullCharge.payment_intent as string;
    if (!paymentIntentId) return;

    const disputeAmount = dispute.amount || 0;

    const result = await reverseWaterfallDistribution(
      paymentIntentId,
      disputeAmount,
      "dispute"
    );

    if (!result.success) {
      console.error(`[Waterfall] Dispute reversal failed for PI:${paymentIntentId}:`, result.errors);
    } else {
      console.log(`[Waterfall] Dispute reversal for PI:${paymentIntentId} — $${(disputeAmount / 100).toFixed(2)}`);
    }

    // Log to CFO audit log
    await supabase.from("cfo_audit_log").insert({
      action: "dispute_created",
      details: {
        dispute_id: dispute.id,
        charge_id: chargeId,
        payment_intent_id: paymentIntentId,
        amount: disputeAmount,
        reason: dispute.reason,
        status: dispute.status,
      },
    });
  } catch (err) {
    console.error("[Waterfall] Error handling dispute:", err);
  }
}
