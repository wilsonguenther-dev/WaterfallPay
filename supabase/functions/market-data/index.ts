import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const url = new URL(req.url);
    const idsParam = url.searchParams.get("ids") || "bitcoin,solana";
    const ids = idsParam
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 10);

    const cgUrl =
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
      `&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(cgUrl, { headers: { "User-Agent": "Drivia/1.0" } });
    if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
    const raw = await res.json();

    const cryptos: Record<string, { usd: number; change24h: number }> = {};
    for (const id of ids) {
      const row = raw?.[id];
      if (!row) continue;
      cryptos[id] = {
        usd: Number(row.usd || 0),
        change24h: Number(row.usd_24h_change || 0),
      };
    }

    return new Response(
      JSON.stringify({
        ok: true,
        cryptos,
        btc: cryptos.bitcoin || { usd: 0, change24h: 0 },
        sol: cryptos.solana || { usd: 0, change24h: 0 },
        timestamp: new Date().toISOString(),
      }),
      { headers: corsHeaders },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error?.message || "Market data error",
        cryptos: {},
        btc: { usd: 0, change24h: 0 },
        sol: { usd: 0, change24h: 0 },
      }),
      { headers: corsHeaders },
    );
  }
});


