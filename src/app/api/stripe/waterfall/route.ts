/**
 * WATERFALL DISTRIBUTION ADMIN API
 * 
 * Actions:
 *   - list-distributions: Paginated list of all waterfall distributions
 *   - get-distribution: Single distribution details
 *   - retry-failed: Retry failed transfers for a distribution
 *   - list-ledger: Browse the financial ledger
 *   - get-reserves: Get company reserve balances
 *   - get-equity-partners: List all equity partners + their balances
 *   - update-equity: Update equity percentages (super_admin only)
 *   - manual-adjustment: Manual ledger adjustment (super_admin only)
 *   - get-waterfall-config: Get current waterfall config
 *   - update-waterfall-config: Update waterfall config (super_admin only)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { retryFailedTransfers } from "@/lib/waterfall-engine";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );
}

async function verifyAdminAccess(req: NextRequest) {
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

  const isAdmin = ["super_admin", "org_admin"].includes(profile?.role || "");
  if (!isAdmin) {
    const { data: cfoDelegate } = await supabase
      .from("cfo_delegates")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (!cfoDelegate) return null;
  }

  return { user, role: profile?.role || "unknown" };
}

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyAdminAccess(req);
    if (!auth) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { action } = body;
    const supabase = getSupabase();

    // ─── LIST DISTRIBUTIONS ───
    if (action === "list-distributions") {
      const { limit = 50, offset = 0, status: filterStatus } = body;
      let q = supabase
        .from("waterfall_distributions")
        .select("*, team_members!waterfall_distributions_closer_member_id_fkey(full_name)")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (filterStatus) q = q.eq("status", filterStatus);
      const { data, error, count } = await q;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      return NextResponse.json({ ok: true, distributions: data || [], count });
    }

    // ─── GET SINGLE DISTRIBUTION ───
    if (action === "get-distribution") {
      const { distributionId } = body;
      if (!distributionId) return NextResponse.json({ error: "distributionId required" }, { status: 400 });

      const { data, error } = await supabase
        .from("waterfall_distributions")
        .select("*")
        .eq("id", distributionId)
        .single();

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Also get related ledger entries
      const { data: ledgerEntries } = await supabase
        .from("financial_ledger")
        .select("*")
        .eq("distribution_id", distributionId)
        .order("created_at", { ascending: true });

      return NextResponse.json({ ok: true, distribution: data, ledger: ledgerEntries || [] });
    }

    // ─── RETRY FAILED TRANSFERS ───
    if (action === "retry-failed") {
      const { distributionId } = body;
      if (!distributionId) return NextResponse.json({ error: "distributionId required" }, { status: 400 });

      const result = await retryFailedTransfers(distributionId);

      // Log the retry attempt
      await supabase.from("cfo_audit_log").insert({
        action: "waterfall_retry",
        performed_by: auth.user.id,
        details: { distribution_id: distributionId, success: result.success, errors: result.errors },
      });

      return NextResponse.json({ ok: true, ...result });
    }

    // ─── LIST LEDGER ───
    if (action === "list-ledger") {
      const { limit = 100, offset = 0, entry_type, payment_intent_id, member_id } = body;
      let q = supabase
        .from("financial_ledger")
        .select("*, team_members(full_name)")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (entry_type) q = q.eq("entry_type", entry_type);
      if (payment_intent_id) q = q.eq("payment_intent_id", payment_intent_id);
      if (member_id) q = q.eq("member_id", member_id);

      const { data, error } = await q;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      return NextResponse.json({ ok: true, entries: data || [] });
    }

    // ─── GET RESERVES ───
    if (action === "get-reserves") {
      const { data, error } = await supabase
        .from("company_reserves")
        .select("*")
        .order("bucket");

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, reserves: data || [] });
    }

    // ─── GET EQUITY PARTNERS ───
    if (action === "get-equity-partners") {
      const { data, error } = await supabase
        .from("team_members")
        .select("id, full_name, title, equity_percent, is_equity_partner, is_closer, is_rounding_sink, stripe_connect_account_id, connect_payouts_enabled, negative_balance_cents, lifetime_commission_cents, lifetime_equity_cents, is_active_member, auth_id")
        .eq("is_equity_partner", true)
        .order("equity_percent", { ascending: false });

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      // Enrich with employee_balances if auth_id exists
      const partners = data || [];
      const enriched = [];
      for (const p of partners) {
        let balance = null;
        if (p.auth_id) {
          const { data: bal } = await supabase
            .from("employee_balances")
            .select("available_cents, pending_cents, lifetime_earned_cents, lifetime_paid_cents")
            .eq("user_id", p.auth_id)
            .maybeSingle();
          balance = bal;
        }

        // Check connect account status
        let connectStatus = null;
        if (p.auth_id) {
          const { data: conn } = await supabase
            .from("stripe_connect_accounts")
            .select("stripe_account_id, onboarding_complete, payouts_enabled")
            .eq("user_id", p.auth_id)
            .maybeSingle();
          connectStatus = conn;
        }

        enriched.push({ ...p, balance, connect_status: connectStatus });
      }

      return NextResponse.json({ ok: true, partners: enriched });
    }

    // ─── UPDATE EQUITY (super_admin only) ───
    if (action === "update-equity") {
      if (auth.role !== "super_admin") {
        return NextResponse.json({ error: "Only super_admin can update equity" }, { status: 403 });
      }

      const { updates } = body;
      if (!Array.isArray(updates)) {
        return NextResponse.json({ error: "updates array required" }, { status: 400 });
      }

      // Validate total = 100%
      const total = updates.reduce((sum: number, u: any) => sum + (u.equity_percent || 0), 0);
      if (Math.abs(total - 100) > 0.01) {
        return NextResponse.json({ error: `Equity total must be 100%, got ${total}%` }, { status: 400 });
      }

      for (const u of updates) {
        await supabase.from("team_members").update({
          equity_percent: u.equity_percent,
          is_equity_partner: u.equity_percent > 0,
        }).eq("id", u.member_id);
      }

      await supabase.from("cfo_audit_log").insert({
        action: "equity_updated",
        performed_by: auth.user.id,
        details: { updates },
      });

      return NextResponse.json({ ok: true });
    }

    // ─── MANUAL ADJUSTMENT (super_admin only) ───
    if (action === "manual-adjustment") {
      if (auth.role !== "super_admin") {
        return NextResponse.json({ error: "Only super_admin can make adjustments" }, { status: 403 });
      }

      const { member_id, amount_cents, reason } = body;
      if (!amount_cents || !reason) {
        return NextResponse.json({ error: "amount_cents and reason required" }, { status: 400 });
      }

      await supabase.from("financial_ledger").insert({
        entry_type: "ADJUSTMENT",
        member_id: member_id || null,
        amount_cents,
        currency: "usd",
        performed_by: auth.user.id,
        metadata: { reason, manual: true },
      });

      // If member-specific, update their balance
      if (member_id) {
        const { data: member } = await supabase
          .from("team_members")
          .select("auth_id")
          .eq("id", member_id)
          .single();

        if (member?.auth_id) {
          const { data: balance } = await supabase
            .from("employee_balances")
            .select("available_cents")
            .eq("user_id", member.auth_id)
            .maybeSingle();

          if (balance) {
            await supabase.from("employee_balances").update({
              available_cents: (balance.available_cents || 0) + amount_cents,
              updated_at: new Date().toISOString(),
            }).eq("user_id", member.auth_id);
          }
        }
      }

      await supabase.from("cfo_audit_log").insert({
        action: "manual_adjustment",
        performed_by: auth.user.id,
        details: { member_id, amount_cents, reason },
      });

      return NextResponse.json({ ok: true });
    }

    // ─── GET WATERFALL CONFIG ───
    if (action === "get-waterfall-config") {
      const { data, error } = await supabase
        .from("waterfall_config")
        .select("*")
        .order("config_key");

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, config: data || [] });
    }

    // ─── UPDATE WATERFALL CONFIG (super_admin only) ───
    if (action === "update-waterfall-config") {
      if (auth.role !== "super_admin") {
        return NextResponse.json({ error: "Only super_admin can update config" }, { status: 403 });
      }

      const { config_key, config_value } = body;
      if (!config_key || config_value === undefined) {
        return NextResponse.json({ error: "config_key and config_value required" }, { status: 400 });
      }

      // Validate percentage configs
      if (["tax_percent", "ops_percent", "commission_percent", "equity_pool_percent"].includes(config_key)) {
        const val = parseFloat(config_value);
        if (isNaN(val) || val < 0 || val > 100) {
          return NextResponse.json({ error: "Percentage must be 0-100" }, { status: 400 });
        }
      }

      await supabase.from("waterfall_config").update({
        config_value: String(config_value),
        updated_by: auth.user.id,
        updated_at: new Date().toISOString(),
      }).eq("config_key", config_key);

      await supabase.from("cfo_audit_log").insert({
        action: "config_updated",
        performed_by: auth.user.id,
        details: { config_key, config_value },
      });

      return NextResponse.json({ ok: true });
    }

    // ─── GET DISTRIBUTION SUMMARY (dashboard KPIs) ───
    if (action === "get-summary") {
      // Total distributed
      const { data: totals } = await supabase
        .from("waterfall_distributions")
        .select("gross_amount_cents, tax_amount_cents, ops_amount_cents, commission_amount_cents, equity_pool_cents, status");

      const allDists = totals || [];
      const completedDists = allDists.filter((d: any) => d.status === "completed" || d.status === "partial");

      const summary = {
        total_distributions: allDists.length,
        completed: completedDists.length,
        failed: allDists.filter((d: any) => d.status === "failed").length,
        pending: allDists.filter((d: any) => d.status === "pending").length,
        total_gross_cents: allDists.reduce((s: number, d: any) => s + (d.gross_amount_cents || 0), 0),
        total_tax_cents: allDists.reduce((s: number, d: any) => s + (d.tax_amount_cents || 0), 0),
        total_ops_cents: allDists.reduce((s: number, d: any) => s + (d.ops_amount_cents || 0), 0),
        total_commission_cents: allDists.reduce((s: number, d: any) => s + (d.commission_amount_cents || 0), 0),
        total_equity_cents: allDists.reduce((s: number, d: any) => s + (d.equity_pool_cents || 0), 0),
      };

      // Reserves
      const { data: reserves } = await supabase.from("company_reserves").select("*");

      return NextResponse.json({ ok: true, summary, reserves: reserves || [] });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("[Waterfall API]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
