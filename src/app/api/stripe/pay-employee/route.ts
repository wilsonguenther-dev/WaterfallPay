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

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabase();
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Only super_admin, org_admin, or CFO delegates
    const { data: profile } = await supabase.from("user_profiles").select("role").eq("auth_id", user.id).single();
    const isAdmin = ["super_admin", "org_admin"].includes(profile?.role || "");
    if (!isAdmin) {
      const { data: cfoDelegate } = await supabase.from("cfo_delegates").select("id").eq("user_id", user.id).eq("is_active", true).maybeSingle();
      if (!cfoDelegate) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { action } = body;

    // ─── APPROVE PAYOUT REQUEST ───
    if (action === "approve") {
      const { requestId } = body;
      if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });

      const { data: request } = await supabase
        .from("payout_requests")
        .select("*, stripe_connect_accounts(stripe_account_id, payouts_enabled)")
        .eq("id", requestId)
        .single();

      if (!request) return NextResponse.json({ error: "Request not found" }, { status: 404 });
      if (request.status !== "pending") return NextResponse.json({ error: `Cannot approve: status is ${request.status}` }, { status: 400 });

      const connectAccount = (request as any).stripe_connect_accounts;
      if (!connectAccount?.stripe_account_id || !connectAccount.payouts_enabled) {
        return NextResponse.json({ error: "Employee payout account not ready" }, { status: 400 });
      }

      // Execute Stripe transfer
      const stripe = getStripe();
      const transfer = await stripe.transfers.create({
        amount: request.amount_cents,
        currency: request.currency || "usd",
        destination: connectAccount.stripe_account_id,
        description: request.description || `Drivia payout - ${request.category}`,
        metadata: {
          payout_request_id: requestId,
          user_id: request.user_id,
          category: request.category,
        },
      });

      // Update request status
      await supabase.from("payout_requests").update({
        status: "paid",
        stripe_transfer_id: transfer.id,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", requestId);

      // Update employee balance
      await supabase.from("employee_balances").update({
        pending_cents: 0,
        lifetime_paid_cents: request.amount_cents,
        last_payout_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("user_id", request.user_id);

      // Log to ledger
      await supabase.from("payout_ledger").insert({
        payout_request_id: requestId,
        user_id: request.user_id,
        action: "paid",
        amount_cents: request.amount_cents,
        performed_by: user.id,
        details: { stripe_transfer_id: transfer.id },
      });

      return NextResponse.json({ ok: true, transferId: transfer.id });
    }

    // ─── REJECT PAYOUT REQUEST ───
    if (action === "reject") {
      const { requestId, reason } = body;
      if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });

      const { data: request } = await supabase
        .from("payout_requests")
        .select("*")
        .eq("id", requestId)
        .single();

      if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (request.status !== "pending") return NextResponse.json({ error: `Cannot reject: status is ${request.status}` }, { status: 400 });

      await supabase.from("payout_requests").update({
        status: "rejected",
        rejected_reason: reason || "Rejected by admin",
        approved_by: user.id,
        updated_at: new Date().toISOString(),
      }).eq("id", requestId);

      // Return funds to available balance
      const { data: bal } = await supabase.from("employee_balances").select("available_cents, pending_cents").eq("user_id", request.user_id).single();
      if (bal) {
        await supabase.from("employee_balances").update({
          available_cents: (bal.available_cents || 0) + request.amount_cents,
          pending_cents: Math.max(0, (bal.pending_cents || 0) - request.amount_cents),
          updated_at: new Date().toISOString(),
        }).eq("user_id", request.user_id);
      }

      await supabase.from("payout_ledger").insert({
        payout_request_id: requestId,
        user_id: request.user_id,
        action: "rejected",
        amount_cents: request.amount_cents,
        performed_by: user.id,
        details: { reason },
      });

      return NextResponse.json({ ok: true });
    }

    // ─── SEND DIRECT PAYOUT (no request needed — admin sends directly) ───
    if (action === "direct-pay") {
      const { userId, amount_cents, category, description } = body;
      if (!userId || !amount_cents || amount_cents <= 0) {
        return NextResponse.json({ error: "userId and amount_cents required" }, { status: 400 });
      }

      const { data: connectAccount } = await supabase
        .from("stripe_connect_accounts")
        .select("stripe_account_id, payouts_enabled")
        .eq("user_id", userId)
        .maybeSingle();

      if (!connectAccount?.stripe_account_id || !connectAccount.payouts_enabled) {
        return NextResponse.json({ error: "Employee has not set up payout account" }, { status: 400 });
      }

      const stripe = getStripe();
      const transfer = await stripe.transfers.create({
        amount: amount_cents,
        currency: "usd",
        destination: connectAccount.stripe_account_id,
        description: description || `Drivia direct payout - ${category || "general"}`,
        metadata: { user_id: userId, category: category || "general", sent_by: user.id },
      });

      // Update balance
      await supabase.from("employee_balances").upsert({
        user_id: userId,
        lifetime_paid_cents: amount_cents,
        last_payout_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      await supabase.from("payout_ledger").insert({
        user_id: userId,
        action: "paid",
        amount_cents,
        performed_by: user.id,
        details: { stripe_transfer_id: transfer.id, category, description, direct: true },
      });

      return NextResponse.json({ ok: true, transferId: transfer.id });
    }

    // ─── LIST ALL PAYOUT REQUESTS (admin view) ───
    if (action === "list-requests") {
      const { status: filterStatus, limit: lim } = body;
      let q = supabase
        .from("payout_requests")
        .select("*, stripe_connect_accounts(stripe_account_id, display_name, email)")
        .order("created_at", { ascending: false })
        .limit(lim || 50);

      if (filterStatus) q = q.eq("status", filterStatus);
      const { data, error } = await q;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Enrich with user profiles
      const userIds = [...new Set((data || []).map((r: any) => r.user_id))];
      const { data: profiles } = await supabase
        .from("user_profiles")
        .select("auth_id, display_name, email")
        .in("auth_id", userIds);

      const profileMap = new Map((profiles || []).map((p: any) => [p.auth_id, p]));
      const enriched = (data || []).map((r: any) => ({
        ...r,
        user_profile: profileMap.get(r.user_id) || null,
      }));

      return NextResponse.json({ ok: true, requests: enriched });
    }

    // ─── LIST ALL CONNECTED ACCOUNTS (admin view) ───
    if (action === "list-accounts") {
      const { data, error } = await supabase
        .from("stripe_connect_accounts")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const userIds = (data || []).map((a: any) => a.user_id);
      const { data: profiles } = await supabase
        .from("user_profiles")
        .select("auth_id, display_name, email, role")
        .in("auth_id", userIds);

      const profileMap = new Map((profiles || []).map((p: any) => [p.auth_id, p]));
      const enriched = (data || []).map((a: any) => ({
        ...a,
        user_profile: profileMap.get(a.user_id) || null,
      }));

      return NextResponse.json({ ok: true, accounts: enriched });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("[Pay Employee]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
