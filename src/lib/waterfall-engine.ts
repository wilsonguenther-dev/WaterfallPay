/**
 * DRIVIA WATERFALL DISTRIBUTION ENGINE
 * 
 * Gross-Based Waterfall Allocation:
 *   50% Company Reserves (25% Tax + 25% Ops)
 *   50% Distribution Pool (10% Commission + 40% Equity)
 * 
 * Instant payouts via Stripe Connect transfers.
 * Append-only financial_ledger for full auditability.
 * Rounding delta goes to the designated rounding sink member.
 */

import Stripe from "stripe";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ─── Types ───────────────────────────────────────────────────

interface WaterfallConfig {
  tax_percent: number;
  ops_percent: number;
  commission_percent: number;
  equity_pool_percent: number;
}

interface EquityPartner {
  id: string;
  full_name: string;
  equity_percent: number;
  is_rounding_sink: boolean;
  stripe_connect_account_id: string | null;
  connect_payouts_enabled: boolean;
  auth_id: string | null;
}

interface EquityAllocation {
  member_id: string;
  member_name: string;
  equity_percent: number;
  amount_cents: number;
  transfer_id: string | null;
  transfer_status: "pending" | "sent" | "failed" | "skipped";
  error?: string;
}

interface DistributionResult {
  success: boolean;
  distribution_id: string | null;
  gross_amount_cents: number;
  tax_amount_cents: number;
  ops_amount_cents: number;
  commission_amount_cents: number;
  equity_pool_cents: number;
  commission_transfer_id: string | null;
  equity_allocations: EquityAllocation[];
  rounding_delta_cents: number;
  errors: string[];
}

// ─── Helpers ─────────────────────────────────────────────────

function getServiceSupabase(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key, { apiVersion: "2024-12-18.acacia" as any });
}

async function loadWaterfallConfig(supabase: SupabaseClient): Promise<WaterfallConfig> {
  const { data } = await supabase
    .from("waterfall_config")
    .select("config_key, config_value")
    .in("config_key", ["tax_percent", "ops_percent", "commission_percent", "equity_pool_percent"]);

  const configMap = new Map((data || []).map((r: any) => [r.config_key, parseFloat(r.config_value)]));

  return {
    tax_percent: configMap.get("tax_percent") ?? 25,
    ops_percent: configMap.get("ops_percent") ?? 25,
    commission_percent: configMap.get("commission_percent") ?? 10,
    equity_pool_percent: configMap.get("equity_pool_percent") ?? 40,
  };
}

async function loadEquityPartners(supabase: SupabaseClient): Promise<EquityPartner[]> {
  const { data } = await supabase
    .from("team_members")
    .select("id, full_name, equity_percent, is_rounding_sink, stripe_connect_account_id, connect_payouts_enabled, auth_id")
    .eq("is_equity_partner", true)
    .eq("is_active_member", true)
    .order("equity_percent", { ascending: false });

  return (data || []) as EquityPartner[];
}

// ─── Core Waterfall Engine ───────────────────────────────────

/**
 * Execute the full waterfall distribution for a payment.
 * 
 * @param paymentIntentId - Stripe PaymentIntent ID (idempotency key)
 * @param grossAmountCents - Gross amount in cents
 * @param currency - Currency code (default: usd)
 * @param closerMemberId - team_member.id of the closer (optional)
 * @param stripFeeCents - Stripe processing fee in cents
 * @param metadata - Additional metadata for the distribution
 */
export async function executeWaterfallDistribution(
  paymentIntentId: string,
  grossAmountCents: number,
  currency: string = "usd",
  closerMemberId?: string | null,
  stripFeeCents: number = 0,
  metadata: Record<string, any> = {}
): Promise<DistributionResult> {
  const supabase = getServiceSupabase();
  const stripe = getStripeClient();
  const errors: string[] = [];

  // ── Idempotency: check if already distributed ──
  const { data: existingDist } = await supabase
    .from("waterfall_distributions")
    .select("id, status")
    .eq("payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (existingDist) {
    console.log(`[Waterfall] Already distributed for ${paymentIntentId} (${existingDist.status})`);
    return {
      success: existingDist.status === "completed",
      distribution_id: existingDist.id,
      gross_amount_cents: grossAmountCents,
      tax_amount_cents: 0,
      ops_amount_cents: 0,
      commission_amount_cents: 0,
      equity_pool_cents: 0,
      commission_transfer_id: null,
      equity_allocations: [],
      rounding_delta_cents: 0,
      errors: ["Already processed — idempotency guard"],
    };
  }

  // ── Load config + equity partners ──
  const config = await loadWaterfallConfig(supabase);
  const partners = await loadEquityPartners(supabase);

  // ── Validate: total equity must be 100% ──
  const totalEquity = partners.reduce((sum, p) => sum + Number(p.equity_percent), 0);
  if (Math.abs(totalEquity - 100) > 0.01) {
    errors.push(`Equity total is ${totalEquity}%, expected 100%. Aborting.`);
    return {
      success: false, distribution_id: null, gross_amount_cents: grossAmountCents,
      tax_amount_cents: 0, ops_amount_cents: 0, commission_amount_cents: 0,
      equity_pool_cents: 0, commission_transfer_id: null, equity_allocations: [],
      rounding_delta_cents: 0, errors,
    };
  }

  // ── Calculate waterfall splits (all from gross) ──
  const taxCents = Math.floor(grossAmountCents * (config.tax_percent / 100));
  const opsCents = Math.floor(grossAmountCents * (config.ops_percent / 100));
  const commissionCents = Math.floor(grossAmountCents * (config.commission_percent / 100));
  const equityPoolCents = Math.floor(grossAmountCents * (config.equity_pool_percent / 100));

  // ── Rounding: calculate delta and assign to sink ──
  const allocatedTotal = taxCents + opsCents + commissionCents + equityPoolCents;
  let roundingDelta = grossAmountCents - allocatedTotal;

  // ── Per-partner equity allocation ──
  const equityAllocations: EquityAllocation[] = [];
  let equityAllocatedTotal = 0;

  for (const partner of partners) {
    const partnerShare = Math.floor(equityPoolCents * (Number(partner.equity_percent) / 100));
    equityAllocatedTotal += partnerShare;
    equityAllocations.push({
      member_id: partner.id,
      member_name: partner.full_name,
      equity_percent: Number(partner.equity_percent),
      amount_cents: partnerShare,
      transfer_id: null,
      transfer_status: "pending",
    });
  }

  // Equity rounding delta goes to the sink member
  const equityDelta = equityPoolCents - equityAllocatedTotal;
  const sinkPartner = partners.find(p => p.is_rounding_sink) || partners[0];
  if (equityDelta !== 0 && sinkPartner) {
    const sinkAlloc = equityAllocations.find(a => a.member_id === sinkPartner.id);
    if (sinkAlloc) {
      sinkAlloc.amount_cents += equityDelta;
    }
  }

  // Overall rounding delta also goes to sink (added to equity allocation)
  if (roundingDelta !== 0 && sinkPartner) {
    const sinkAlloc = equityAllocations.find(a => a.member_id === sinkPartner.id);
    if (sinkAlloc) {
      sinkAlloc.amount_cents += roundingDelta;
    }
  }

  // ── Find closer for commission ──
  let closerName = "Unassigned";
  let closerConnectAccountId: string | null = null;
  if (closerMemberId) {
    const closer = partners.find(p => p.id === closerMemberId);
    if (closer) {
      closerName = closer.full_name;
      closerConnectAccountId = closer.stripe_connect_account_id;
    } else {
      // Closer might not be an equity partner — look them up separately
      const { data: closerData } = await supabase
        .from("team_members")
        .select("full_name, stripe_connect_account_id, connect_payouts_enabled")
        .eq("id", closerMemberId)
        .single();
      if (closerData) {
        closerName = closerData.full_name;
        closerConnectAccountId = closerData.stripe_connect_account_id;
      }
    }
  }

  // ── Find payment row to link distribution ──
  const { data: paymentRow } = await supabase
    .from("payments")
    .select("id")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  const paymentId = paymentRow?.id;
  if (!paymentId) {
    errors.push(`No payment row found for PI ${paymentIntentId}`);
    return {
      success: false, distribution_id: null, gross_amount_cents: grossAmountCents,
      tax_amount_cents: taxCents, ops_amount_cents: opsCents,
      commission_amount_cents: commissionCents, equity_pool_cents: equityPoolCents,
      commission_transfer_id: null, equity_allocations: equityAllocations,
      rounding_delta_cents: roundingDelta, errors,
    };
  }

  // ── Create distribution record ──
  const { data: dist, error: distErr } = await supabase
    .from("waterfall_distributions")
    .insert({
      payment_id: paymentId,
      payment_intent_id: paymentIntentId,
      gross_amount_cents: grossAmountCents,
      currency,
      tax_amount_cents: taxCents,
      ops_amount_cents: opsCents,
      stripe_fee_cents: stripFeeCents,
      commission_amount_cents: commissionCents,
      equity_pool_cents: equityPoolCents,
      closer_member_id: closerMemberId || null,
      closer_name: closerName,
      equity_allocations: equityAllocations,
      status: "pending",
      rounding_delta_cents: roundingDelta + equityDelta,
      rounding_sink_member_id: sinkPartner?.id || null,
      metadata,
    })
    .select("id")
    .single();

  if (distErr || !dist) {
    errors.push(`Failed to create distribution: ${distErr?.message}`);
    return {
      success: false, distribution_id: null, gross_amount_cents: grossAmountCents,
      tax_amount_cents: taxCents, ops_amount_cents: opsCents,
      commission_amount_cents: commissionCents, equity_pool_cents: equityPoolCents,
      commission_transfer_id: null, equity_allocations: equityAllocations,
      rounding_delta_cents: roundingDelta, errors,
    };
  }

  const distributionId = dist.id;

  // ══════════════════════════════════════════════════════════════
  // STEP 1: ALLOCATE COMPANY RESERVES
  // ══════════════════════════════════════════════════════════════

  // Tax bucket
  try {
    const { error: taxRpcErr } = await supabase.rpc("increment_reserve", { p_bucket: "TAX_BUCKET", p_amount: taxCents });
    if (taxRpcErr) throw taxRpcErr;
  } catch {
    const { data: reserve } = await supabase.from("company_reserves").select("balance_cents, lifetime_allocated_cents").eq("bucket", "TAX_BUCKET").single();
    if (reserve) {
      await supabase.from("company_reserves").update({
        balance_cents: reserve.balance_cents + taxCents,
        lifetime_allocated_cents: reserve.lifetime_allocated_cents + taxCents,
        updated_at: new Date().toISOString(),
      }).eq("bucket", "TAX_BUCKET");
    }
  }

  await writeLedgerEntry(supabase, {
    entry_type: "TAX_ALLOC",
    payment_intent_id: paymentIntentId,
    distribution_id: distributionId,
    amount_cents: taxCents,
    currency,
    metadata: { percent: config.tax_percent, gross: grossAmountCents },
  });

  // Ops bucket
  try {
    const { error: opsRpcErr } = await supabase.rpc("increment_reserve", { p_bucket: "OPS_BUCKET", p_amount: opsCents });
    if (opsRpcErr) throw opsRpcErr;
  } catch {
    const { data: reserve } = await supabase.from("company_reserves").select("balance_cents, lifetime_allocated_cents").eq("bucket", "OPS_BUCKET").single();
    if (reserve) {
      await supabase.from("company_reserves").update({
        balance_cents: reserve.balance_cents + opsCents,
        lifetime_allocated_cents: reserve.lifetime_allocated_cents + opsCents,
        updated_at: new Date().toISOString(),
      }).eq("bucket", "OPS_BUCKET");
    }
  }

  await writeLedgerEntry(supabase, {
    entry_type: "OPS_ALLOC",
    payment_intent_id: paymentIntentId,
    distribution_id: distributionId,
    amount_cents: opsCents,
    currency,
    metadata: { percent: config.ops_percent, gross: grossAmountCents, stripe_fee_cents: stripFeeCents },
  });

  // ══════════════════════════════════════════════════════════════
  // STEP 2: COMMISSION TRANSFER (to closer's Stripe Connect)
  // ══════════════════════════════════════════════════════════════

  let commissionTransferId: string | null = null;

  if (commissionCents > 0 && closerConnectAccountId) {
    try {
      const transfer = await stripe.transfers.create({
        amount: commissionCents,
        currency,
        destination: closerConnectAccountId,
        description: `Drivia commission — ${closerName} — PI:${paymentIntentId.slice(-8)}`,
        metadata: {
          distribution_id: distributionId,
          payment_intent_id: paymentIntentId,
          type: "commission",
          closer_member_id: closerMemberId || "",
        },
      });
      commissionTransferId = transfer.id;

      await supabase.from("waterfall_distributions").update({
        commission_transfer_id: transfer.id,
        commission_transfer_status: "sent",
      }).eq("id", distributionId);

      // Update member lifetime commission
      if (closerMemberId) {
        const { data: member } = await supabase
          .from("team_members")
          .select("lifetime_commission_cents")
          .eq("id", closerMemberId)
          .single();
        if (member) {
          await supabase.from("team_members").update({
            lifetime_commission_cents: (member.lifetime_commission_cents || 0) + commissionCents,
          }).eq("id", closerMemberId);
        }
      }

      await writeLedgerEntry(supabase, {
        entry_type: "COMMISSION_ALLOC",
        payment_intent_id: paymentIntentId,
        distribution_id: distributionId,
        member_id: closerMemberId || undefined,
        amount_cents: commissionCents,
        currency,
        stripe_transfer_id: transfer.id,
        metadata: { closer_name: closerName, percent: config.commission_percent },
      });

      await writeLedgerEntry(supabase, {
        entry_type: "TRANSFER_SENT",
        payment_intent_id: paymentIntentId,
        distribution_id: distributionId,
        member_id: closerMemberId || undefined,
        amount_cents: commissionCents,
        currency,
        stripe_transfer_id: transfer.id,
        metadata: { type: "commission", destination: closerConnectAccountId },
      });

    } catch (err: any) {
      errors.push(`Commission transfer failed: ${err.message}`);
      await supabase.from("waterfall_distributions").update({
        commission_transfer_status: "failed",
        error_message: err.message,
      }).eq("id", distributionId);

      // Still log the allocation even if transfer failed
      await writeLedgerEntry(supabase, {
        entry_type: "COMMISSION_ALLOC",
        payment_intent_id: paymentIntentId,
        distribution_id: distributionId,
        member_id: closerMemberId || undefined,
        amount_cents: commissionCents,
        currency,
        metadata: { closer_name: closerName, percent: config.commission_percent, transfer_failed: true, error: err.message },
      });
    }
  } else if (commissionCents > 0 && !closerConnectAccountId) {
    // Commission allocated but no Connect account — log to balance instead
    errors.push(`Commission for ${closerName} held: no Stripe Connect account`);
    await writeLedgerEntry(supabase, {
      entry_type: "COMMISSION_ALLOC",
      payment_intent_id: paymentIntentId,
      distribution_id: distributionId,
      member_id: closerMemberId || undefined,
      amount_cents: commissionCents,
      currency,
      metadata: { closer_name: closerName, percent: config.commission_percent, held: true, reason: "no_connect_account" },
    });

    // Credit their employee_balance instead
    if (closerMemberId) {
      await creditMemberBalance(supabase, closerMemberId, commissionCents, "commission");
    }
  }

  // ══════════════════════════════════════════════════════════════
  // STEP 3: EQUITY TRANSFERS (to each partner's Stripe Connect)
  // ══════════════════════════════════════════════════════════════

  for (const alloc of equityAllocations) {
    if (alloc.amount_cents <= 0) {
      alloc.transfer_status = "skipped";
      continue;
    }

    const partner = partners.find(p => p.id === alloc.member_id);
    const connectAccountId = partner?.stripe_connect_account_id;

    if (!connectAccountId) {
      // No Connect account — hold in employee_balance
      alloc.transfer_status = "skipped";
      errors.push(`Equity for ${alloc.member_name} held: no Stripe Connect account`);

      await writeLedgerEntry(supabase, {
        entry_type: "EQUITY_ALLOC",
        payment_intent_id: paymentIntentId,
        distribution_id: distributionId,
        member_id: alloc.member_id,
        amount_cents: alloc.amount_cents,
        currency,
        metadata: { equity_percent: alloc.equity_percent, held: true, reason: "no_connect_account" },
      });

      await creditMemberBalance(supabase, alloc.member_id, alloc.amount_cents, "equity");
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: alloc.amount_cents,
        currency,
        destination: connectAccountId,
        description: `Drivia equity — ${alloc.member_name} (${alloc.equity_percent}%) — PI:${paymentIntentId.slice(-8)}`,
        metadata: {
          distribution_id: distributionId,
          payment_intent_id: paymentIntentId,
          type: "equity",
          member_id: alloc.member_id,
          equity_percent: String(alloc.equity_percent),
        },
      });

      alloc.transfer_id = transfer.id;
      alloc.transfer_status = "sent";

      // Update member lifetime equity
      const { data: member } = await supabase
        .from("team_members")
        .select("lifetime_equity_cents")
        .eq("id", alloc.member_id)
        .single();
      if (member) {
        await supabase.from("team_members").update({
          lifetime_equity_cents: (member.lifetime_equity_cents || 0) + alloc.amount_cents,
        }).eq("id", alloc.member_id);
      }

      await writeLedgerEntry(supabase, {
        entry_type: "EQUITY_ALLOC",
        payment_intent_id: paymentIntentId,
        distribution_id: distributionId,
        member_id: alloc.member_id,
        amount_cents: alloc.amount_cents,
        currency,
        stripe_transfer_id: transfer.id,
        metadata: { equity_percent: alloc.equity_percent, member_name: alloc.member_name },
      });

      await writeLedgerEntry(supabase, {
        entry_type: "TRANSFER_SENT",
        payment_intent_id: paymentIntentId,
        distribution_id: distributionId,
        member_id: alloc.member_id,
        amount_cents: alloc.amount_cents,
        currency,
        stripe_transfer_id: transfer.id,
        metadata: { type: "equity", destination: connectAccountId },
      });

    } catch (err: any) {
      alloc.transfer_status = "failed";
      alloc.error = err.message;
      errors.push(`Equity transfer to ${alloc.member_name} failed: ${err.message}`);

      await writeLedgerEntry(supabase, {
        entry_type: "EQUITY_ALLOC",
        payment_intent_id: paymentIntentId,
        distribution_id: distributionId,
        member_id: alloc.member_id,
        amount_cents: alloc.amount_cents,
        currency,
        metadata: { equity_percent: alloc.equity_percent, transfer_failed: true, error: err.message },
      });

      // Credit balance instead so funds aren't lost
      await creditMemberBalance(supabase, alloc.member_id, alloc.amount_cents, "equity");
    }
  }

  // ══════════════════════════════════════════════════════════════
  // STEP 4: FINALIZE DISTRIBUTION
  // ══════════════════════════════════════════════════════════════

  const allTransfersSucceeded = equityAllocations.every(a => a.transfer_status === "sent" || a.transfer_status === "skipped");
  const commissionOk = !closerConnectAccountId || commissionTransferId !== null;
  const finalStatus = (allTransfersSucceeded && commissionOk) ? "completed"
    : errors.length > 0 ? "partial" : "completed";

  await supabase.from("waterfall_distributions").update({
    equity_allocations: equityAllocations,
    status: finalStatus,
    completed_at: new Date().toISOString(),
    error_message: errors.length > 0 ? errors.join("; ") : null,
  }).eq("id", distributionId);

  // Mark payment as distributed
  if (paymentId) {
    await supabase.from("payments").update({
      distribution_status: finalStatus,
      distributed_at: new Date().toISOString(),
      closer_member_id: closerMemberId || null,
    }).eq("id", paymentId);
  }

  console.log(`[Waterfall] Distribution ${distributionId} for PI:${paymentIntentId} — ${finalStatus} — $${(grossAmountCents / 100).toFixed(2)}`);

  return {
    success: finalStatus === "completed",
    distribution_id: distributionId,
    gross_amount_cents: grossAmountCents,
    tax_amount_cents: taxCents,
    ops_amount_cents: opsCents,
    commission_amount_cents: commissionCents,
    equity_pool_cents: equityPoolCents,
    commission_transfer_id: commissionTransferId,
    equity_allocations: equityAllocations,
    rounding_delta_cents: roundingDelta + equityDelta,
    errors,
  };
}

// ─── Refund/Dispute Reversal ─────────────────────────────────

/**
 * Reverse a waterfall distribution due to refund or dispute.
 * Creates negative ledger entries and negative balances for members.
 */
export async function reverseWaterfallDistribution(
  paymentIntentId: string,
  refundAmountCents: number,
  reason: "refund" | "dispute",
  stripeRefundId?: string
): Promise<{ success: boolean; errors: string[] }> {
  const supabase = getServiceSupabase();
  const errors: string[] = [];

  // Find the original distribution
  const { data: dist } = await supabase
    .from("waterfall_distributions")
    .select("*")
    .eq("payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (!dist) {
    return { success: false, errors: [`No distribution found for PI ${paymentIntentId}`] };
  }

  const isFullRefund = refundAmountCents >= dist.gross_amount_cents;
  const refundRatio = Math.min(refundAmountCents / dist.gross_amount_cents, 1);

  // Proportional reversal of each bucket
  const taxReversal = Math.round(dist.tax_amount_cents * refundRatio);
  const opsReversal = Math.round(dist.ops_amount_cents * refundRatio);
  const commissionReversal = Math.round(dist.commission_amount_cents * refundRatio);
  const equityPoolReversal = Math.round(dist.equity_pool_cents * refundRatio);

  const entryType = reason === "refund" ? "REFUND_REVERSAL" : "DISPUTE_REVERSAL";

  // Reverse company reserves
  const { data: taxReserve } = await supabase.from("company_reserves").select("balance_cents").eq("bucket", "TAX_BUCKET").single();
  if (taxReserve) {
    await supabase.from("company_reserves").update({
      balance_cents: taxReserve.balance_cents - taxReversal,
      updated_at: new Date().toISOString(),
    }).eq("bucket", "TAX_BUCKET");
  }

  await writeLedgerEntry(supabase, {
    entry_type: entryType,
    payment_intent_id: paymentIntentId,
    distribution_id: dist.id,
    amount_cents: -taxReversal,
    currency: dist.currency,
    metadata: { bucket: "TAX_BUCKET", reason, refund_ratio: refundRatio, stripe_refund_id: stripeRefundId },
  });

  const { data: opsReserve } = await supabase.from("company_reserves").select("balance_cents").eq("bucket", "OPS_BUCKET").single();
  if (opsReserve) {
    await supabase.from("company_reserves").update({
      balance_cents: opsReserve.balance_cents - opsReversal,
      updated_at: new Date().toISOString(),
    }).eq("bucket", "OPS_BUCKET");
  }

  await writeLedgerEntry(supabase, {
    entry_type: entryType,
    payment_intent_id: paymentIntentId,
    distribution_id: dist.id,
    amount_cents: -opsReversal,
    currency: dist.currency,
    metadata: { bucket: "OPS_BUCKET", reason, refund_ratio: refundRatio },
  });

  // Reverse commission — create negative balance for closer
  if (commissionReversal > 0 && dist.closer_member_id) {
    const { data: member } = await supabase
      .from("team_members")
      .select("negative_balance_cents")
      .eq("id", dist.closer_member_id)
      .single();

    if (member) {
      await supabase.from("team_members").update({
        negative_balance_cents: (member.negative_balance_cents || 0) + commissionReversal,
      }).eq("id", dist.closer_member_id);
    }

    await writeLedgerEntry(supabase, {
      entry_type: entryType,
      payment_intent_id: paymentIntentId,
      distribution_id: dist.id,
      member_id: dist.closer_member_id,
      amount_cents: -commissionReversal,
      currency: dist.currency,
      metadata: { type: "commission", reason, closer_name: dist.closer_name },
    });
  }

  // Reverse equity — negative balances for each partner proportionally
  const originalAllocations: EquityAllocation[] = dist.equity_allocations || [];
  for (const alloc of originalAllocations) {
    const partnerReversal = Math.round(alloc.amount_cents * refundRatio);
    if (partnerReversal <= 0) continue;

    const { data: member } = await supabase
      .from("team_members")
      .select("negative_balance_cents")
      .eq("id", alloc.member_id)
      .single();

    if (member) {
      await supabase.from("team_members").update({
        negative_balance_cents: (member.negative_balance_cents || 0) + partnerReversal,
      }).eq("id", alloc.member_id);
    }

    await writeLedgerEntry(supabase, {
      entry_type: entryType,
      payment_intent_id: paymentIntentId,
      distribution_id: dist.id,
      member_id: alloc.member_id,
      amount_cents: -partnerReversal,
      currency: dist.currency,
      metadata: { type: "equity", reason, equity_percent: alloc.equity_percent, member_name: alloc.member_name },
    });
  }

  // Update distribution status
  await supabase.from("waterfall_distributions").update({
    status: isFullRefund ? "reversed" : "partial_reversal",
    error_message: `${reason}: $${(refundAmountCents / 100).toFixed(2)} reversed`,
  }).eq("id", dist.id);

  // Update payment status
  await supabase.from("payments").update({
    distribution_status: isFullRefund ? "reversed" : "partial_reversal",
    status: isFullRefund ? "refunded" : "partial_refund",
  }).eq("stripe_payment_intent_id", paymentIntentId);

  console.log(`[Waterfall] ${reason} reversal for PI:${paymentIntentId} — $${(refundAmountCents / 100).toFixed(2)}`);

  return { success: true, errors };
}

// ─── Retry Failed Transfers ──────────────────────────────────

/**
 * Retry failed transfers for a distribution.
 */
export async function retryFailedTransfers(distributionId: string): Promise<{ success: boolean; errors: string[] }> {
  const supabase = getServiceSupabase();
  const stripe = getStripeClient();
  const errors: string[] = [];

  const { data: dist } = await supabase
    .from("waterfall_distributions")
    .select("*")
    .eq("id", distributionId)
    .single();

  if (!dist) return { success: false, errors: ["Distribution not found"] };

  const allocations: EquityAllocation[] = dist.equity_allocations || [];
  let anyRetried = false;

  // Retry commission if failed
  if (dist.commission_transfer_status === "failed" && dist.closer_member_id) {
    const { data: closer } = await supabase
      .from("team_members")
      .select("stripe_connect_account_id, full_name")
      .eq("id", dist.closer_member_id)
      .single();

    if (closer?.stripe_connect_account_id) {
      try {
        const transfer = await stripe.transfers.create({
          amount: dist.commission_amount_cents,
          currency: dist.currency,
          destination: closer.stripe_connect_account_id,
          description: `Drivia commission RETRY — ${closer.full_name} — PI:${dist.payment_intent_id.slice(-8)}`,
          metadata: { distribution_id: distributionId, type: "commission_retry" },
        });

        await supabase.from("waterfall_distributions").update({
          commission_transfer_id: transfer.id,
          commission_transfer_status: "sent",
        }).eq("id", distributionId);

        await writeLedgerEntry(supabase, {
          entry_type: "TRANSFER_SENT",
          payment_intent_id: dist.payment_intent_id,
          distribution_id: distributionId,
          member_id: dist.closer_member_id,
          amount_cents: dist.commission_amount_cents,
          currency: dist.currency,
          stripe_transfer_id: transfer.id,
          metadata: { type: "commission_retry" },
        });

        anyRetried = true;
      } catch (err: any) {
        errors.push(`Commission retry failed: ${err.message}`);
      }
    }
  }

  // Retry failed equity transfers
  for (const alloc of allocations) {
    if (alloc.transfer_status !== "failed") continue;

    const { data: partner } = await supabase
      .from("team_members")
      .select("stripe_connect_account_id")
      .eq("id", alloc.member_id)
      .single();

    if (!partner?.stripe_connect_account_id) continue;

    try {
      const transfer = await stripe.transfers.create({
        amount: alloc.amount_cents,
        currency: dist.currency,
        destination: partner.stripe_connect_account_id,
        description: `Drivia equity RETRY — ${alloc.member_name} — PI:${dist.payment_intent_id.slice(-8)}`,
        metadata: { distribution_id: distributionId, type: "equity_retry", member_id: alloc.member_id },
      });

      alloc.transfer_id = transfer.id;
      alloc.transfer_status = "sent";

      await writeLedgerEntry(supabase, {
        entry_type: "TRANSFER_SENT",
        payment_intent_id: dist.payment_intent_id,
        distribution_id: distributionId,
        member_id: alloc.member_id,
        amount_cents: alloc.amount_cents,
        currency: dist.currency,
        stripe_transfer_id: transfer.id,
        metadata: { type: "equity_retry" },
      });

      anyRetried = true;
    } catch (err: any) {
      alloc.error = err.message;
      errors.push(`Equity retry for ${alloc.member_name} failed: ${err.message}`);
    }
  }

  if (anyRetried) {
    const allOk = allocations.every(a => a.transfer_status === "sent" || a.transfer_status === "skipped");
    await supabase.from("waterfall_distributions").update({
      equity_allocations: allocations,
      status: allOk ? "completed" : "partial",
      error_message: errors.length > 0 ? errors.join("; ") : null,
    }).eq("id", distributionId);
  }

  return { success: errors.length === 0, errors };
}

// ─── Helper: Credit Member Balance ───────────────────────────

async function creditMemberBalance(
  supabase: SupabaseClient,
  memberId: string,
  amountCents: number,
  type: "commission" | "equity"
) {
  const { data: member } = await supabase
    .from("team_members")
    .select("auth_id")
    .eq("id", memberId)
    .single();

  if (!member?.auth_id) return;

  const { data: balance } = await supabase
    .from("employee_balances")
    .select("*")
    .eq("user_id", member.auth_id)
    .maybeSingle();

  if (balance) {
    const updates: any = {
      available_cents: (balance.available_cents || 0) + amountCents,
      lifetime_earned_cents: (balance.lifetime_earned_cents || 0) + amountCents,
      updated_at: new Date().toISOString(),
    };
    if (type === "commission") {
      updates.commission_earned_cents = (balance.commission_earned_cents || 0) + amountCents;
    } else {
      updates.equity_earned_cents = (balance.equity_earned_cents || 0) + amountCents;
    }
    await supabase.from("employee_balances").update(updates).eq("user_id", member.auth_id);
  } else {
    await supabase.from("employee_balances").insert({
      user_id: member.auth_id,
      member_id: memberId,
      available_cents: amountCents,
      lifetime_earned_cents: amountCents,
      commission_earned_cents: type === "commission" ? amountCents : 0,
      equity_earned_cents: type === "equity" ? amountCents : 0,
    });
  }
}

// ─── Helper: Write Ledger Entry ──────────────────────────────

async function writeLedgerEntry(
  supabase: SupabaseClient,
  entry: {
    entry_type: string;
    payment_intent_id?: string;
    distribution_id?: string;
    member_id?: string;
    amount_cents: number;
    currency?: string;
    stripe_transfer_id?: string;
    performed_by?: string;
    metadata?: Record<string, any>;
  }
) {
  // Get previous hash for chain integrity
  const { data: lastEntry } = await supabase
    .from("financial_ledger")
    .select("integrity_hash")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const prevHash = lastEntry?.integrity_hash || "GENESIS";

  // Simple hash: SHA-256 of prev_hash + entry data
  const hashInput = `${prevHash}|${entry.entry_type}|${entry.amount_cents}|${entry.payment_intent_id || ""}|${Date.now()}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(hashInput);

  let integrityHash: string;
  try {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    integrityHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Fallback if crypto.subtle not available
    integrityHash = `hash_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  await supabase.from("financial_ledger").insert({
    entry_type: entry.entry_type,
    payment_intent_id: entry.payment_intent_id || null,
    distribution_id: entry.distribution_id || null,
    member_id: entry.member_id || null,
    amount_cents: entry.amount_cents,
    currency: entry.currency || "usd",
    stripe_transfer_id: entry.stripe_transfer_id || null,
    performed_by: entry.performed_by || null,
    metadata: entry.metadata || {},
    integrity_hash: integrityHash,
    prev_hash: prevHash,
  });
}
