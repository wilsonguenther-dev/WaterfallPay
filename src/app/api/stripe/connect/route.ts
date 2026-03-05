import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );
}

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const supabase = getSupabase();
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { action } = body;
    const supabase = getSupabase();
    const stripeClient = getStripe();

    // ═══════════════════════════════════════════════════════════
    // CREATE CONNECTED ACCOUNT (Express — payout recipients)
    // Express accounts are for affiliates/sales people who need
    // to RECEIVE payouts, not sell products. Lightweight onboarding:
    // just identity verification + bank account. No business setup,
    // no product types, no tax collection forms.
    // ═══════════════════════════════════════════════════════════
    if (action === "create-account") {
      // Check if user already has a connect account in our DB
      const { data: existing } = await supabase
        .from("stripe_connect_accounts")
        .select("id, stripe_account_id, onboarding_complete")
        .eq("user_id", user.id)
        .maybeSingle();

      // If already onboarded, return early
      if (existing?.stripe_account_id && existing.onboarding_complete) {
        return NextResponse.json({ ok: true, alreadyComplete: true, accountId: existing.stripe_account_id });
      }

      let stripeAccountId = existing?.stripe_account_id;

      if (!stripeAccountId) {
        // Get user profile for prefilling name/email
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("display_name, email")
          .eq("auth_id", user.id)
          .single();

        // Create Express connected account — TRANSFERS ONLY
        // This gives affiliates a simple onboarding: verify identity + add bank account
        // No merchant setup, no product selection, no tax collection
        try {
          const account = await stripeClient.accounts.create({
            type: "express",
            country: (body.country || "US").toUpperCase(),
            email: profile?.email || user.email || undefined,
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            business_type: "individual",
            business_profile: {
              product_description: "Drivia affiliate/sales representative — receives commission payouts",
              url: "https://drivia.consulting",
            },
            metadata: {
              drivia_user_id: user.id,
              platform: "drivia",
              role: "affiliate",
            },
            settings: {
              payouts: {
                schedule: { interval: "manual" as const },
              },
            },
          });

          stripeAccountId = account.id;
        } catch (err: any) {
          if (err.message?.includes("signed up for Connect")) {
            return NextResponse.json({
              error: "Stripe Connect is not enabled. Go to https://dashboard.stripe.com/settings/connect to activate it.",
              connectNotEnabled: true,
            }, { status: 400 });
          }
          throw err;
        }

        // Save mapping from Drivia user → Stripe account ID in our DB
        await supabase.from("stripe_connect_accounts").upsert({
          user_id: user.id,
          stripe_account_id: stripeAccountId,
          account_type: "express",
          email: profile?.email || user.email,
          display_name: profile?.display_name,
          country: body.country || "US",
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      }

      // Create onboarding link — Express uses the same accountLinks API
      // but Stripe serves a much simpler form (identity + bank account only)
      const origin = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "https://drivia.consulting";
      const accountLink = await stripeClient.accountLinks.create({
        account: stripeAccountId!,
        refresh_url: `${origin}/dashboard/payouts?refresh=true`,
        return_url: `${origin}/dashboard/payouts?onboarding=complete`,
        type: "account_onboarding",
      });

      return NextResponse.json({ ok: true, url: accountLink.url, accountId: stripeAccountId });
    }

    // ═══════════════════════════════════════════════════════════
    // CHECK ACCOUNT STATUS
    // Retrieves the Express account status from Stripe V1 API.
    // Express accounts use: details_submitted, payouts_enabled.
    // ═══════════════════════════════════════════════════════════
    if (action === "check-status") {
      const { data: connectAccount } = await supabase
        .from("stripe_connect_accounts")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!connectAccount?.stripe_account_id) {
        return NextResponse.json({ ok: true, hasAccount: false });
      }

      let account;
      try {
        account = await stripeClient.accounts.retrieve(connectAccount.stripe_account_id);
      } catch (stripeErr: any) {
        // Account may have been deleted from Stripe — clean up our record
        if (stripeErr?.statusCode === 404 || stripeErr?.code === "resource_missing") {
          await supabase.from("stripe_connect_accounts").delete().eq("user_id", user.id);
          return NextResponse.json({ ok: true, hasAccount: false });
        }
        throw stripeErr;
      }
      const onboardingComplete = account.details_submitted || false;
      const chargesEnabled = account.charges_enabled || false;
      const payoutsEnabled = account.payouts_enabled || false;
      const detailsSubmitted = account.details_submitted || false;

      // Update DB with latest status from Stripe
      const updates = {
        onboarding_complete: onboardingComplete,
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        details_submitted: detailsSubmitted,
        updated_at: new Date().toISOString(),
      };

      await supabase.from("stripe_connect_accounts").update(updates).eq("user_id", user.id);

      return NextResponse.json({
        ok: true,
        hasAccount: true,
        accountId: connectAccount.stripe_account_id,
        ...updates,
        email: connectAccount.email,
        country: connectAccount.country,
      });
    }

    // ═══════════════════════════════════════════════════════════
    // CREATE LOGIN LINK
    // Lets the connected account user manage their Stripe Dashboard
    // (bank details, payout schedule, tax info, etc.)
    // ═══════════════════════════════════════════════════════════
    if (action === "login-link") {
      const { data: connectAccount } = await supabase
        .from("stripe_connect_accounts")
        .select("stripe_account_id, onboarding_complete")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!connectAccount?.stripe_account_id || !connectAccount.onboarding_complete) {
        return NextResponse.json({ error: "Account not set up" }, { status: 400 });
      }

      const loginLink = await stripeClient.accounts.createLoginLink(connectAccount.stripe_account_id);
      return NextResponse.json({ ok: true, url: loginLink.url });
    }

    // ═══════════════════════════════════════════════════════════
    // REQUEST PAYOUT
    // Employee requests withdrawal of available earnings.
    // Goes through approval workflow before Stripe transfer executes.
    // ═══════════════════════════════════════════════════════════
    if (action === "request-payout") {
      const { amount_cents, category, description } = body;
      if (!amount_cents || amount_cents <= 0) {
        return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
      }

      // Verify user has a connected account with payouts enabled
      const { data: connectAccount } = await supabase
        .from("stripe_connect_accounts")
        .select("id, stripe_account_id, payouts_enabled")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!connectAccount?.stripe_account_id || !connectAccount.payouts_enabled) {
        return NextResponse.json({ error: "Payout account not set up or payouts not enabled" }, { status: 400 });
      }

      // Check available balance
      const { data: balance } = await supabase
        .from("employee_balances")
        .select("available_cents")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!balance || balance.available_cents < amount_cents) {
        return NextResponse.json({ error: "Insufficient balance" }, { status: 400 });
      }

      // Enforce minimum payout from platform config
      const { data: minConfig } = await supabase
        .from("payout_config")
        .select("config_value")
        .eq("config_key", "minimum_payout_cents")
        .maybeSingle();
      const minPayout = parseInt(minConfig?.config_value || "10000");
      if (amount_cents < minPayout) {
        return NextResponse.json({ error: `Minimum payout is $${(minPayout / 100).toFixed(0)}` }, { status: 400 });
      }

      // Check dual-approval threshold
      const { data: dualConfig } = await supabase
        .from("payout_config")
        .select("config_value")
        .eq("config_key", "dual_approval_threshold_cents")
        .maybeSingle();
      const dualThreshold = parseInt(dualConfig?.config_value || "100000");
      const requiresDualApproval = amount_cents >= dualThreshold;

      // Create payout request
      const { data: request, error: insertErr } = await supabase
        .from("payout_requests")
        .insert({
          user_id: user.id,
          connect_account_id: connectAccount.id,
          amount_cents,
          category: category || "general",
          description: description || null,
          status: "pending",
          requires_dual_approval: requiresDualApproval,
        })
        .select("id")
        .single();

      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

      // Move amount from available to pending
      try {
        await supabase.rpc("transfer_to_pending", { p_user_id: user.id, p_amount: amount_cents });
      } catch {
        await supabase.from("employee_balances").update({
          available_cents: (balance.available_cents || 0) - amount_cents,
          pending_cents: amount_cents,
          updated_at: new Date().toISOString(),
        }).eq("user_id", user.id);
      }

      // Log to immutable ledger (hash chain computed by DB trigger)
      await supabase.from("payout_ledger").insert({
        payout_request_id: request.id,
        user_id: user.id,
        action: "created",
        amount_cents,
        performed_by: user.id,
        details: { category, description, requires_dual_approval: requiresDualApproval },
      });

      return NextResponse.json({ ok: true, requestId: request.id, requiresDualApproval });
    }

    // ═══════════════════════════════════════════════════════════
    // CREATE BILLING PORTAL SESSION
    // Lets connected accounts manage their subscription to the platform
    // ═══════════════════════════════════════════════════════════
    if (action === "billing-portal") {
      const { data: connectAccount } = await supabase
        .from("stripe_connect_accounts")
        .select("stripe_account_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!connectAccount?.stripe_account_id) {
        return NextResponse.json({ error: "No connected account" }, { status: 400 });
      }

      const origin = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "https://drivia.consulting";
      const session = await stripeClient.billingPortal.sessions.create({
        customer_account: connectAccount.stripe_account_id,
        return_url: `${origin}/dashboard/payouts`,
      } as any);

      return NextResponse.json({ ok: true, url: (session as any).url });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("[Stripe Connect]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
