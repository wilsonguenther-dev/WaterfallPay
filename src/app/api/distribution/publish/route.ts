import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/distribution/publish
 * Trigger the publish-worker edge function for queued/scheduled jobs.
 * Auth: admin users or CRON_SECRET bearer token.
 */
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  let isAuthed = false;

  // Cron auth
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    isAuthed = true;
  }

  // Admin auth
  if (!isAuthed) {
    try {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("role")
          .eq("auth_id", user.id)
          .single();
        if (profile && ["super_admin", "org_admin"].includes(profile.role)) {
          isAuthed = true;
        }
      }
    } catch { /* ignore */ }
  }

  if (!isAuthed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Call the publish-worker edge function
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/publish-worker`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error("[Distribution Publish] Error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/**
 * GET /api/distribution/publish
 * Get current publish queue status
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const admin = createAdminClient();

    const [
      { count: queued },
      { count: publishing },
      { count: published },
      { count: failed },
      { data: recentJobs },
    ] = await Promise.all([
      admin.from("publish_jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
      admin.from("publish_jobs").select("id", { count: "exact", head: true }).eq("status", "publishing"),
      admin.from("publish_jobs").select("id", { count: "exact", head: true }).eq("status", "published"),
      admin.from("publish_jobs").select("id", { count: "exact", head: true }).in("status", ["failed", "dead"]),
      admin.from("publish_jobs").select("*").order("updated_at", { ascending: false }).limit(20),
    ]);

    return NextResponse.json({
      stats: { queued: queued ?? 0, publishing: publishing ?? 0, published: published ?? 0, failed: failed ?? 0 },
      recentJobs: recentJobs ?? [],
    });
  } catch (error) {
    console.error("[Distribution Publish] Error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
