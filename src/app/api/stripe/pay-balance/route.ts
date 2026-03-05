import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("id, email, display_name, stripe_customer_id")
      .eq("auth_id", user.id)
      .single();

    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }

    const body = await req.json();
    const { paymentPlanId, amountCents } = body as { paymentPlanId: string; amountCents: number };

    if (!paymentPlanId || !amountCents || amountCents < 100) {
      return NextResponse.json({ error: "Payment plan ID and amount (min $1) are required" }, { status: 400 });
    }

    // Fetch the payment plan — verify ownership
    const { data: plan } = await supabase
      .from("payment_plans")
      .select("*")
      .eq("id", paymentPlanId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .single();

    if (!plan) {
      return NextResponse.json({ error: "Active payment plan not found" }, { status: 404 });
    }

    const remaining = plan.total_amount_cents - plan.paid_amount_cents;
    if (amountCents > remaining) {
      return NextResponse.json({ error: `Amount exceeds remaining balance of $${(remaining / 100).toFixed(2)}` }, { status: 400 });
    }

    const stripe = getStripe();
    const origin = req.headers.get("origin") || "https://drivia.consulting";

    // Get or create Stripe customer
    let customerId = profile.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile.email || user.email || "",
        name: profile.display_name || "",
        metadata: { drivia_user_id: profile.id, auth_id: user.id },
      });
      customerId = customer.id;

      await supabase
        .from("user_profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", profile.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{
        price_data: {
          currency: plan.currency || "usd",
          product_data: {
            name: `Payment — ${plan.description || plan.plan_type}`,
            description: `Partial payment of $${(amountCents / 100).toFixed(2)} toward $${(plan.total_amount_cents / 100).toFixed(2)} balance`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      success_url: `${origin}/dashboard/account?payment=success&plan_payment=true`,
      cancel_url: `${origin}/dashboard/account?canceled=true`,
      metadata: {
        drivia_user_id: profile.id,
        plan: "balance_payment",
        payment_plan_id: paymentPlanId,
        amount_cents: String(amountCents),
      },
      billing_address_collection: "auto",
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[Stripe Pay Balance]", err);
    return NextResponse.json(
      { error: "Failed to create payment session" },
      { status: 500 }
    );
  }
}
