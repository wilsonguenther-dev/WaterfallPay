"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Activity, CheckCircle2, AlertTriangle, XCircle,
  RefreshCw, Copy, ExternalLink, ChevronDown, ChevronUp,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";

interface HealthCheck {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail";
  message: string;
  debug?: string;
  fixUrl?: string;
}

const CATEGORIES = [
  { key: "workers", label: "Worker Heartbeats" },
  { key: "cron", label: "Cron Jobs" },
  { key: "vault", label: "Vault Secrets" },
  { key: "oauth", label: "OAuth Health" },
  { key: "queue", label: "Queue Health" },
];

const statusIcon = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
};

const statusColor = {
  pass: "text-emerald-600",
  warn: "text-yellow-600",
  fail: "text-red-600",
};

const statusBg = {
  pass: "bg-emerald-500/10 border-emerald-500/20",
  warn: "bg-yellow-500/10 border-yellow-500/20",
  fail: "bg-red-500/10 border-red-500/20",
};

export function HealthDashboardClient({ initialChecks }: { initialChecks: HealthCheck[] }) {
  const router = useRouter();
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const grouped = useMemo(() => {
    const map: Record<string, HealthCheck[]> = {};
    for (const c of initialChecks) {
      (map[c.category] ??= []).push(c);
    }
    return map;
  }, [initialChecks]);

  const summary = useMemo(() => {
    let pass = 0, warn = 0, fail = 0;
    for (const c of initialChecks) {
      if (c.status === "pass") pass++;
      else if (c.status === "warn") warn++;
      else fail++;
    }
    return { pass, warn, fail, total: initialChecks.length };
  }, [initialChecks]);

  const overallStatus = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const OverallIcon = statusIcon[overallStatus];

  async function handleRefresh() {
    setRefreshing(true);
    router.refresh();
    setTimeout(() => setRefreshing(false), 1500);
  }

  function copyDebug() {
    const debugStr = initialChecks
      .map((c) => `[${c.status.toUpperCase()}] ${c.name}: ${c.message}${c.debug ? ` | ${c.debug}` : ""}`)
      .join("\n");
    navigator.clipboard.writeText(debugStr);
    toast({ title: "Debug info copied" });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6" /> System Health
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {summary.pass} pass, {summary.warn} warn, {summary.fail} fail — {summary.total} checks
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={copyDebug}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            <Copy className="h-3.5 w-3.5" /> Copy Debug
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Overall Status Banner */}
      <div className={`flex items-center gap-3 rounded-xl border p-4 ${statusBg[overallStatus]}`}>
        <OverallIcon className={`h-6 w-6 ${statusColor[overallStatus]}`} />
        <div>
          <p className={`text-sm font-semibold ${statusColor[overallStatus]}`}>
            {overallStatus === "pass" ? "All Systems Operational" : overallStatus === "warn" ? "Some Warnings Detected" : "Issues Detected"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Last checked: {new Date().toLocaleTimeString()}
          </p>
        </div>
      </div>

      {/* Category Panels */}
      <div className="space-y-3">
        {CATEGORIES.map((cat) => {
          const checks = grouped[cat.key] ?? [];
          if (checks.length === 0) return null;

          const catFail = checks.filter((c) => c.status === "fail").length;
          const catWarn = checks.filter((c) => c.status === "warn").length;
          const catStatus = catFail > 0 ? "fail" : catWarn > 0 ? "warn" : "pass";
          const CatIcon = statusIcon[catStatus];
          const isExpanded = expandedCategory === cat.key;

          return (
            <div key={cat.key} className="rounded-xl border border-border bg-card overflow-hidden">
              <button
                onClick={() => setExpandedCategory(isExpanded ? null : cat.key)}
                className="flex w-full items-center justify-between p-4 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <CatIcon className={`h-4 w-4 ${statusColor[catStatus]}`} />
                  <span className="text-sm font-semibold">{cat.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {checks.length} check{checks.length !== 1 ? "s" : ""}
                  </span>
                </div>
                {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>

              {isExpanded && (
                <div className="border-t border-border divide-y divide-border">
                  {checks.map((check, i) => {
                    const Icon = statusIcon[check.status];
                    return (
                      <div key={i} className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Icon className={`h-4 w-4 shrink-0 ${statusColor[check.status]}`} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{check.name}</p>
                            <p className="text-xs text-muted-foreground">{check.message}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-3">
                          {check.debug && (
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(check.debug!);
                                toast({ title: "Copied" });
                              }}
                              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                              title="Copy debug"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          )}
                          {check.fixUrl && check.status !== "pass" && (
                            <a
                              href={check.fixUrl}
                              className="rounded-md p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
                              title="Fix"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
