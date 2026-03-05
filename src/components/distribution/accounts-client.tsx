"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Link2,
  Plus,
  Shield,
  ShieldOff,
  RefreshCw,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/hooks/use-toast";

interface Account {
  id: string;
  user_id: string;
  platform: string;
  account_type: string;
  provider_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  scopes: string[] | null;
  status: string;
  expires_at: string | null;
  admin_disabled: boolean;
  created_at: string;
  updated_at: string;
}

const platformMeta: Record<string, { label: string; color: string; connectHref?: string }> = {
  linkedin: { label: "LinkedIn", color: "bg-blue-600", connectHref: "/api/linkedin/oauth" },
  youtube: { label: "YouTube", color: "bg-red-600" },
  instagram: { label: "Instagram", color: "bg-gradient-to-br from-purple-500 to-pink-500" },
  tiktok: { label: "TikTok", color: "bg-black dark:bg-zinc-800" },
  x_twitter: { label: "X / Twitter", color: "bg-black dark:bg-zinc-800" },
  facebook: { label: "Facebook", color: "bg-blue-500" },
};

export function AccountsClient({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  async function toggleDisabled(account: Account) {
    setLoading(account.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("provider_accounts")
      .update({ admin_disabled: !account.admin_disabled, updated_at: new Date().toISOString() })
      .eq("id", account.id);

    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: account.admin_disabled ? "Autopilot enabled" : "Autopilot disabled" });
      router.refresh();
    }
    setLoading(null);
  }

  async function disconnectAccount(account: Account) {
    if (!confirm(`Disconnect ${account.display_name || account.platform}? This will revoke access.`)) return;
    setLoading(account.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("provider_accounts")
      .update({ status: "revoked", updated_at: new Date().toISOString() })
      .eq("id", account.id);

    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Account disconnected" });
      router.refresh();
    }
    setLoading(null);
  }

  async function connectLinkedIn() {
    setLoading("connect");
    try {
      const res = await fetch("/api/linkedin/oauth");
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        toast({ title: "Error", description: data.error || "Could not start OAuth", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Error", description: "Failed to initiate connection", variant: "destructive" });
    }
    setLoading(null);
  }

  const activeAccounts = accounts.filter((a) => a.status === "active");
  const inactiveAccounts = accounts.filter((a) => a.status !== "active");

  function isExpiringSoon(expiresAt: string | null) {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Platform Accounts</h1>
          <p className="text-sm text-muted-foreground">Connect and manage your publishing accounts</p>
        </div>
        <button
          onClick={connectLinkedIn}
          disabled={loading === "connect"}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Connect Account
        </button>
      </div>

      {/* Connect Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Object.entries(platformMeta).map(([key, meta]) => {
          const connected = activeAccounts.some((a) => a.platform === key);
          return (
            <button
              key={key}
              onClick={key === "linkedin" ? connectLinkedIn : undefined}
              disabled={key !== "linkedin"}
              className="flex flex-col items-center gap-2 rounded-xl border border-border p-4 transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className={`h-8 w-8 rounded-lg ${meta.color} flex items-center justify-center text-xs font-bold text-white`}>
                {meta.label.charAt(0)}
              </div>
              <span className="text-xs font-medium">{meta.label}</span>
              {connected ? (
                <span className="text-[10px] text-emerald-600 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" />Connected</span>
              ) : (
                <span className="text-[10px] text-muted-foreground">{key === "linkedin" ? "Connect" : "Coming soon"}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active Accounts Table */}
      {activeAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-12 text-center">
          <Link2 className="h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">No accounts connected</p>
          <p className="mt-1 text-xs text-muted-foreground">Connect a platform to start publishing</p>
          <button
            onClick={connectLinkedIn}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Connect LinkedIn
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Account</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Platform</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Expires</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Last Used</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Autopilot</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activeAccounts.map((account) => {
                const meta = platformMeta[account.platform] || { label: account.platform, color: "bg-muted" };
                const expiring = isExpiringSoon(account.expires_at);
                return (
                  <tr key={account.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {account.avatar_url ? (
                          <img src={account.avatar_url} alt="" className="h-7 w-7 rounded-full" />
                        ) : (
                          <div className={`h-7 w-7 rounded-full ${meta.color} flex items-center justify-center text-xs font-bold text-white`}>
                            {(account.display_name || "?").charAt(0)}
                          </div>
                        )}
                        <span className="font-medium truncate max-w-[150px]">{account.display_name || account.provider_user_id}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                        <div className={`h-2 w-2 rounded-full ${meta.color}`} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {expiring ? (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                          <AlertTriangle className="h-3 w-3" /> Expiring
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                          <CheckCircle2 className="h-3 w-3" /> Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {account.expires_at ? (
                        <span className={expiring ? "text-amber-600 font-medium" : ""}>
                          {new Date(account.expires_at).toLocaleDateString()}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {account.updated_at ? timeAgo(account.updated_at) : "Never"}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => toggleDisabled(account)}
                        disabled={loading === account.id}
                        className="flex items-center gap-1.5 text-xs disabled:opacity-50"
                        title={account.admin_disabled ? "Enable autopilot" : "Disable autopilot"}
                      >
                        {account.admin_disabled ? (
                          <><ShieldOff className="h-3.5 w-3.5 text-red-500" /><span className="text-red-600">Off</span></>
                        ) : (
                          <><Shield className="h-3.5 w-3.5 text-emerald-500" /><span className="text-emerald-600">On</span></>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => disconnectAccount(account)}
                          disabled={loading === account.id}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                          title="Disconnect"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Inactive Accounts */}
      {inactiveAccounts.length > 0 && (
        <div className="rounded-xl border border-border bg-card/50">
          <div className="border-b border-border px-4 py-2.5">
            <h3 className="text-xs font-semibold text-muted-foreground">Inactive / Revoked ({inactiveAccounts.length})</h3>
          </div>
          <div className="divide-y divide-border">
            {inactiveAccounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between px-4 py-2.5 opacity-60">
                <div className="flex items-center gap-2">
                  <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">
                    {(account.display_name || "?").charAt(0)}
                  </div>
                  <span className="text-sm">{account.display_name || account.provider_user_id}</span>
                  <span className="text-xs text-muted-foreground capitalize">{account.platform}</span>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">{account.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
