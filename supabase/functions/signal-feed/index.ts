import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const CRYPTO_SETS = [
  ["bitcoin", "solana"],
  ["ethereum", "cardano", "polkadot"],
  ["bitcoin", "ethereum", "solana"],
  ["ripple", "dogecoin", "chainlink"],
];

const STOCK_SETS = [
  ["AAPL", "MSFT", "GOOGL"],
  ["TSLA", "NVDA", "META"],
  ["AMZN", "AMD", "NFLX"],
  ["DIS", "INTC", "CRM"],
];

function pickRandom<T>(sets: T[][]): T[] {
  const idx = Math.floor(Math.random() * sets.length);
  return sets[idx] || sets[0];
}

function esc(s: string) {
  return (s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(String(lat))}` +
      `&lon=${encodeURIComponent(String(lon))}&format=json&addressdetails=1`;
    const res = await fetch(url, { headers: { "User-Agent": "Drivia/1.0 (driviaofficial@gmail.com)" } });
    if (!res.ok) return "Your Location";
    const data = await res.json().catch(() => ({}));
    const addr = data?.address || {};
    const city =
      addr.city ||
      addr.town ||
      addr.village ||
      addr.suburb ||
      addr.municipality ||
      addr.county ||
      addr.hamlet ||
      "";
    const state = addr.state || "";
    const stateAbbr = state === "Texas" ? "TX" : state;
    if (city && stateAbbr) return `${city}, ${stateAbbr}`;
    if (city) return city;
    if (stateAbbr) return stateAbbr;
    return "Your Location";
  } catch {
    return "Your Location";
  }
}

async function geocodeLocation(text: string): Promise<{ lat: number; lon: number; display: string } | null> {
  try {
    const q = (text || "").trim();
    if (!q) return null;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { "User-Agent": "Drivia/1.0 (driviaofficial@gmail.com)" } });
    if (!res.ok) return null;
    const arr = await res.json().catch(() => []);
    const top = arr?.[0];
    if (!top?.lat || !top?.lon) return null;
    return { lat: Number(top.lat), lon: Number(top.lon), display: q };
  } catch {
    return null;
  }
}

async function fetchCrypto(ids: string[]) {
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
    `&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Drivia/1.0" } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const raw = await res.json().catch(() => ({}));
  return raw;
}

async function fetchStocks(symbols: string[]) {
  const apiKey = Deno.env.get("FINNHUB_API_KEY") || "";
  const out: any[] = [];

  if (apiKey) {
    for (const s of symbols) {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const q = await res.json().catch(() => ({}));
      if (!q || q.c === 0 || q.c == null) continue;
      out.push({ symbol: s, price: Number(q.c), changePercent: Number(q.dp || 0) });
    }
  }

  if (out.length > 0) return out;

  // Yahoo fallback
  const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(yahooUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Drivia/1.0)" } });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const items = data?.quoteResponse?.result || [];
  return items
    .filter((q: any) => q?.regularMarketPrice)
    .map((q: any) => ({
      symbol: q.symbol,
      price: Number(q.regularMarketPrice),
      changePercent: Number(q.regularMarketChangePercent || 0),
    }));
}

async function fetchTrends() {
  const url = "https://trends.google.com/trends/trendingsearches/daily/rss?geo=US";
  const res = await fetch(url);
  if (!res.ok) return [];
  const xml = await res.text();
  const titleMatches = xml.match(/<title>([^<]+)<\/title>/g) || [];
  return titleMatches
    .slice(1, 11)
    .map((m) => m.replace(/<\/?title>/g, "").trim())
    .filter(Boolean);
}

async function fetchNews(query: string) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(rssUrl);
  if (!res.ok) return [];
  const xml = await res.text();
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const headlines: Array<{ title: string; link: string }> = [];
  for (const item of itemMatches.slice(0, 4)) {
    const titleMatch = item.match(/<title>([^<]+)<\/title>/);
    const linkMatch = item.match(/<link>([^<]+)<\/link>/);
    if (!titleMatch || !linkMatch) continue;
    headlines.push({ title: titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim(), link: linkMatch[1].trim() });
  }
  return headlines;
}

async function fetchWeather(lat: number, lon: number, locationText: string) {
  const apiKey = Deno.env.get("OWM_API_KEY") || "";
  if (!apiKey) return { temp: null, condition: "Unavailable", location: locationText };
  const url =
    `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(String(lat))}` +
    `&lon=${encodeURIComponent(String(lon))}&appid=${encodeURIComponent(apiKey)}&units=imperial`;
  const res = await fetch(url);
  if (!res.ok) return { temp: null, condition: "Unavailable", location: locationText };
  const data = await res.json().catch(() => ({}));
  return {
    temp: Math.round(Number(data?.main?.temp || 0)),
    condition: data?.weather?.[0]?.main || "Unknown",
    location: locationText,
  };
}

async function fetchJobs(locationText: string) {
  const appId = Deno.env.get("ADZUNA_APP_ID") || "";
  const appKey = Deno.env.get("ADZUNA_APP_KEY") || "";
  if (!appId || !appKey) return { jobs: [], label: locationText };

  const query = "developer OR engineer OR designer";
  let url =
    `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${encodeURIComponent(appId)}` +
    `&app_key=${encodeURIComponent(appKey)}&results_per_page=3&what=${encodeURIComponent(query)}&content-type=application/json`;
  if (locationText) url += `&where=${encodeURIComponent(locationText)}`;
  const res = await fetch(url);
  if (!res.ok) return { jobs: [], label: locationText };
  const data = await res.json().catch(() => ({}));
  const jobs = (data.results || []).slice(0, 3).map((j: any) => ({
    title: j.title,
    company: j.company?.display_name || "Unknown",
    url: j.redirect_url,
  }));
  return { jobs, label: locationText };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const refresh = (body.refresh || "").toString();
    const locationTextIn = (body.locationText || "").toString().trim();
    const io = body.io || {};

    let lat = body.lat != null ? Number(body.lat) : null;
    let lon = body.lon != null ? Number(body.lon) : null;

    // If user typed location text, geocode it
    if ((!lat || !lon) && locationTextIn) {
      const geo = await geocodeLocation(locationTextIn);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
      }
    }

    // Simulation defaults if denied
    if (!lat || !lon) {
      // Default: San Marcos, TX
      lat = 29.8833;
      lon = -97.9414;
    }

    const locationText = locationTextIn || (await reverseGeocode(lat, lon));

    const cryptoIds = pickRandom(CRYPTO_SETS);
    const stockSyms = pickRandom(STOCK_SETS);

    // Fetch all in parallel
    const [cryptoRaw, stockQuotes, trends, news, weather, jobs] = await Promise.all([
      fetchCrypto(cryptoIds),
      fetchStocks(stockSyms),
      fetchTrends(),
      fetchNews("technology OR AI OR business OR startups"),
      fetchWeather(lat, lon, locationText),
      fetchJobs(locationText),
    ]);

    // Render HTML blocks (frontend just paints)
    const primaryCrypto = cryptoIds[0];
    const primaryCryptoShort =
      primaryCrypto === "bitcoin" ? "BTC" : primaryCrypto === "solana" ? "SOL" : primaryCrypto === "ethereum" ? "ETH" : primaryCrypto.toUpperCase().slice(0, 4);
    const primaryCryptoRow = cryptoRaw?.[primaryCrypto] || {};
    const otherCrypto = cryptoIds.slice(1).map((id) => {
      const row = cryptoRaw?.[id] || {};
      const short =
        id === "bitcoin" ? "BTC" : id === "solana" ? "SOL" : id === "ethereum" ? "ETH" : id === "cardano" ? "ADA" : id === "polkadot" ? "DOT" : id === "dogecoin" ? "DOGE" : id === "ripple" ? "XRP" : id.toUpperCase().slice(0, 4);
      return `${short} $${Number(row.usd || 0).toLocaleString()}`;
    });
    const change = Number(primaryCryptoRow.usd_24h_change || 0);

    const market_html = `
      <div class="signal-mini">
        <h4>₿ CRYPTO <button class="signal-reload-btn" data-refresh="crypto">🔄</button></h4>
        <div class="signal-value">${primaryCryptoShort}: $${Number(primaryCryptoRow.usd || 0).toLocaleString()}</div>
        <div class="signal-change ${change >= 0 ? "positive" : "negative"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</div>
        ${otherCrypto.length ? `<p class="muted" style="font-size:11px;margin-top:6px;">${esc(otherCrypto.join(" · "))}</p>` : ""}
      </div>
    `.trim();

    const primaryStock = stockQuotes?.[0] || null;
    const otherStocks = (stockQuotes || []).slice(1).map((q: any) => `${q.symbol} $${Number(q.price || 0).toLocaleString()}`);
    const stocks_html = `
      <div class="signal-mini">
        <h4>📈 STOCKS <button class="signal-reload-btn" data-refresh="stocks">🔄</button></h4>
        <div class="signal-value">${esc(primaryStock?.symbol || "—")}: $${Number(primaryStock?.price || 0).toLocaleString()}</div>
        <div class="signal-change ${(Number(primaryStock?.changePercent || 0) >= 0) ? "positive" : "negative"}">${Number(primaryStock?.changePercent || 0) >= 0 ? "+" : ""}${Number(primaryStock?.changePercent || 0).toFixed(2)}%</div>
        ${otherStocks.length ? `<p class="muted" style="font-size:11px;margin-top:6px;">${esc(otherStocks.join(" · "))}</p>` : ""}
      </div>
    `.trim();

    const weather_html = `
      <div class="signal-mini">
        <h4>☀️ WEATHER</h4>
        <div class="signal-value">${weather.temp == null ? "—" : `${weather.temp}°F`}</div>
        <div class="signal-change">${esc(weather.condition || "Unknown")}</div>
        <p class="muted" style="font-size:11px;margin-top:6px;">📍 ${esc(locationText)}</p>
      </div>
    `.trim();

    const trends_html = `
      <h4>🔥 TRENDING <button class="signal-reload-btn" data-refresh="trends">🔄</button></h4>
      <div class="trend-pills">
        ${(trends || []).slice(0, 5).map((t: string) => `<span class="trend-pill">${esc(t)}</span>`).join("")}
      </div>
    `.trim();

    const news_html = `
      <div class="signal-mini">
        <h4>📰 TECH NEWS</h4>
        <ul style="margin:10px 0 0 18px;padding:0;">
          ${(news || []).slice(0, 4).map((n: any) => `<li style="margin:6px 0;"><a href="${esc(n.link)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${esc(n.title)}</a></li>`).join("")}
        </ul>
      </div>
    `.trim();

    const jobs_html = `
      <div class="signal-mini">
        <h4>💼 JOBS · ${esc(locationText)}</h4>
        <ul style="margin:10px 0 0 18px;padding:0;">
          ${(jobs.jobs || []).slice(0, 3).map((j: any) => `<li style="margin:6px 0;"><a href="${esc(j.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${esc(j.title)} — ${esc(j.company)}</a></li>`).join("")}
        </ul>
      </div>
    `.trim();

    return new Response(
      JSON.stringify({
        ok: true,
        location_text: locationText,
        io: { geoDenied: !!io.geoDenied },
        render: { market_html, stocks_html, weather_html, trends_html, news_html, jobs_html },
        timestamp: new Date().toISOString(),
      }),
      { headers: corsHeaders },
    );
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error?.message || "Signal feed error" }), { headers: corsHeaders });
  }
});


