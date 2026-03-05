"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Send,
  X,
  RotateCcw,
  Download,
  Pause,
  ExternalLink,
  ChevronRight,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Filter,
  Skull,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/hooks/use-toast";

interface PublishJob {
  id: string;
  platform: string;
  status: string;
  publish_mode: string;
  scheduled_at: string | null;
  published_at: string | null;
  external_id: string | null;
  external_url: string | null;
  external_urn: string | null;
  retry_count: number;
  max_retries: number;
  last_error: string | null;
  next_retry_at: string | null;
  idempotency_key: string | null;
  requires_approval: boolean;
  created_at: string;
  updated_at: string;
  user_id: string;
  content_asset_id: string;
  provider_account_id: string;
}

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "queued", label: "Queued" },
  { key: "scheduled", label: "Scheduled" },
  { key: "publishing", label: "Publishing" },
  { key: "published", label: "Published" },
  { key: "failed", label: "Failed" },
  { key: "dead", label: "Dead" },
];

const statusConfig: Record<string, { icon: typeof Send; color: string; bg: string }> = {
  queued: { icon: Clock, color: "text-blue-600", bg: "bg-blue-500/10" },
  scheduled: { icon: Clock, color: "text-amber-600", bg: "bg-amber-500/10" },
  publishing: { icon: Loader2, color: "text-purple-600", bg: "bg-purple-500/10" },
  published: { icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-500/10" },
  failed: { icon: XCircle, color: "text-red-600", bg: "bg-red-500/10" },
  dead: { icon: Skull, color: "text-red-800", bg: "bg-red-900/10" },
  cancelled: { icon: X, color: "text-muted-foreground", bg: "bg-muted" },
};

export function PublishQueueClient({ initialJobs }: { initialJobs: PublishJob[] }) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);
  const [activeTab, setActiveTab] = useState("all");
  const [selectedJob, setSelectedJob] = useState<PublishJob | null>(null);
  const [auditEvents, setAuditEvents] = useState<Record<string, unknown>[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Realtime Broadcast subscription
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel("dist:publish-updates", {
      config: { broadcast: { self: true } },
    });

    channel.on("broadcast", { event: "publish_job.updated" }, (payload) => {
      const update = payload.payload as { job_id: string; status: string };
      setJobs((prev) =>
        prev.map((j) => (j.id === update.job_id ? { ...j, ...update, status: update.status } : j))
      );
    });

    channel.subscribe();

    // Polling fallback every 15s
    const interval = setInterval(() => {
      router.refresh();
    }, 15000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [router]);

  // Sync with server data on re-render
  useEffect(() => {
    setJobs(initialJobs);
  }, [initialJobs]);

  const filteredJobs = useMemo(() => {
    if (activeTab === "all") return jobs;
    return jobs.filter((j) => j.status === activeTab);
  }, [jobs, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: jobs.length };
    for (const j of jobs) {
      counts[j.status] = (counts[j.status] || 0) + 1;
    }
    return counts;
  }, [jobs]);

  async function loadAuditEvents(jobId: string) {
    const supabase = createClient();
    const { data } = await supabase
      .from("publish_audit_log")
      .select("*")
      .eq("publish_job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(20);
    setAuditEvents(data ?? []);
  }

  async function openDrawer(job: PublishJob) {
    setSelectedJob(job);
    await loadAuditEvents(job.id);
  }

  async function retryJob(jobId: string) {
    setActionLoading(jobId);
    const supabase = createClient();
    const { error } = await supabase
      .from("publish_jobs")
      .update({ status: "queued", last_error: null, next_retry_at: null, updated_at: new Date().toISOString() })
      .eq("id", jobId);

    if (error) {
      toast({ title: "Retry failed", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Job re-queued" });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: "queued", last_error: null } : j)));
      router.refresh();
    }
    setActionLoading(null);
  }

  async function cancelJob(jobId: string) {
    setActionLoading(jobId);
    const supabase = createClient();
    const { error } = await supabase
      .from("publish_jobs")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", jobId);

    if (error) {
      toast({ title: "Cancel failed", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Job cancelled" });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: "cancelled" } : j)));
      router.refresh();
    }
    setActionLoading(null);
  }

  function exportCSV() {
    const headers = ["id", "platform", "status", "scheduled_at", "published_at", "retry_count", "last_error", "external_url"];
    const rows = filteredJobs.map((j) => headers.map((h) => JSON.stringify((j as unknown as Record<string, unknown>)[h] ?? "")).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `publish-jobs-${activeTab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Publish Queue</h1>
          <p className="text-sm text-muted-foreground">{jobs.length} total jobs</p>
        </div>
        <button onClick={exportCSV} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`shrink-0 rounded-t-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {tabCounts[tab.key] ? (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{tabCounts[tab.key]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Table */}
      {filteredJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-12 text-center">
          <Send className="h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">No {activeTab === "all" ? "" : activeTab} jobs</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {activeTab === "all" ? "Create content and schedule a publish job to get started" : `No jobs with status "${activeTab}"`}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Platform</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Scheduled</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Retries</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Error</th>
                <th className="px-4 py-2.5 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredJobs.map((job) => {
                const sc = statusConfig[job.status] || statusConfig.queued;
                const StatusIcon = sc.icon;
                return (
                  <tr
                    key={job.id}
                    className="hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => openDrawer(job)}
                  >
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${sc.bg} ${sc.color}`}>
                        <StatusIcon className={`h-3 w-3 ${job.status === "publishing" ? "animate-spin" : ""}`} />
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="capitalize text-xs">{job.platform}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {job.scheduled_at ? new Date(job.scheduled_at).toLocaleString() : "Immediate"}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {job.retry_count > 0 ? (
                        <span className="text-amber-600">{job.retry_count}/{job.max_retries || 3}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[200px] truncate">
                      {job.last_error || "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {["failed", "dead"].includes(job.status) && (
                          <button
                            onClick={() => retryJob(job.id)}
                            disabled={actionLoading === job.id}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
                            title="Retry"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {["queued", "scheduled"].includes(job.status) && (
                          <button
                            onClick={() => cancelJob(job.id)}
                            disabled={actionLoading === job.id}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {job.external_url && (
                          <a href={job.external_url} target="_blank" rel="noopener noreferrer" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors" title="View post">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                        <button onClick={() => openDrawer(job)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors" title="Details">
                          <ChevronRight className="h-3.5 w-3.5" />
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

      {/* Job Detail Drawer */}
      {selectedJob && (
        <JobDrawer
          job={selectedJob}
          auditEvents={auditEvents}
          onClose={() => { setSelectedJob(null); setAuditEvents([]); }}
          onRetry={() => retryJob(selectedJob.id)}
          onCancel={() => cancelJob(selectedJob.id)}
          actionLoading={actionLoading}
        />
      )}
    </div>
  );
}

function JobDrawer({
  job,
  auditEvents,
  onClose,
  onRetry,
  onCancel,
  actionLoading,
}: {
  job: PublishJob;
  auditEvents: Record<string, unknown>[];
  onClose: () => void;
  onRetry: () => void;
  onCancel: () => void;
  actionLoading: string | null;
}) {
  const sc = statusConfig[job.status] || statusConfig.queued;
  const StatusIcon = sc.icon;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-border bg-card shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-4 py-3">
          <h3 className="text-sm font-semibold">Job Details</h3>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <div className="p-4 space-y-5">
          {/* Status + Actions */}
          <div className="flex items-center justify-between">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${sc.bg} ${sc.color}`}>
              <StatusIcon className="h-3.5 w-3.5" /> {job.status}
            </span>
            <div className="flex gap-2">
              {["failed", "dead"].includes(job.status) && (
                <button onClick={onRetry} disabled={actionLoading === job.id} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  <RotateCcw className="h-3 w-3" /> Retry
                </button>
              )}
              {["queued", "scheduled"].includes(job.status) && (
                <button onClick={onCancel} disabled={actionLoading === job.id} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
                  <X className="h-3 w-3" /> Cancel
                </button>
              )}
            </div>
          </div>

          {/* Info Grid */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <InfoItem label="Job ID" value={job.id.slice(0, 8) + "..."} copyable={job.id} />
            <InfoItem label="Platform" value={job.platform} />
            <InfoItem label="Mode" value={job.publish_mode} />
            <InfoItem label="Retries" value={`${job.retry_count}/${job.max_retries || 3}`} />
            <InfoItem label="Scheduled" value={job.scheduled_at ? new Date(job.scheduled_at).toLocaleString() : "Immediate"} />
            <InfoItem label="Published" value={job.published_at ? new Date(job.published_at).toLocaleString() : "—"} />
            <InfoItem label="Next Retry" value={job.next_retry_at ? new Date(job.next_retry_at).toLocaleString() : "—"} />
            <InfoItem label="Approval" value={job.requires_approval ? "Required" : "Auto"} />
          </div>

          {/* External Link */}
          {job.external_url && (
            <a href={job.external_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-lg border border-border p-3 text-xs hover:bg-muted transition-colors">
              <ExternalLink className="h-4 w-4 text-primary" />
              <span className="truncate flex-1">{job.external_url}</span>
            </a>
          )}

          {/* Error */}
          {job.last_error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Last Error
              </div>
              <p className="mt-1 text-xs text-muted-foreground break-words">{job.last_error}</p>
            </div>
          )}

          {/* Idempotency Key */}
          {job.idempotency_key && (
            <InfoItem label="Idempotency Key" value={job.idempotency_key.slice(0, 12) + "..."} copyable={job.idempotency_key} />
          )}

          {/* Audit Timeline */}
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">Audit Timeline</h4>
            {auditEvents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No audit events</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {auditEvents.map((event, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <div className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{String(event.event_type)}</span>
                      <span className="ml-2 text-muted-foreground">{new Date(event.created_at as string).toLocaleString()}</span>
                      {(() => {
                        const d = event.details;
                        if (d && typeof d === "object" && Object.keys(d as Record<string, unknown>).length > 0) {
                          return <pre className="mt-0.5 rounded bg-muted p-1.5 text-[10px] overflow-x-auto">{JSON.stringify(d, null, 2)}</pre>;
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function InfoItem({ label, value, copyable }: { label: string; value: string; copyable?: string }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <p
        className={`mt-0.5 font-medium ${copyable ? "cursor-pointer hover:text-primary" : ""}`}
        onClick={copyable ? () => { navigator.clipboard.writeText(copyable); toast({ title: "Copied" }); } : undefined}
        title={copyable ? "Click to copy" : undefined}
      >
        {value}
      </p>
    </div>
  );
}
