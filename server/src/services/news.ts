/**
 * News service: curated Fed/economic calendar (server/data/fed-events.json)
 * + live crypto news from public RSS (CoinDesk, CoinTelegraph).
 *
 * Fed event values (actual/forecast/previous) are null unless the source
 * provides them — never invented. RSS is cached 10 minutes; on fetch
 * failure the status degrades (DEGRADED/UNAVAILABLE) and stale cache is
 * served when available — never fake headlines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FedEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  actual: string | number | null;
  forecast: string | number | null;
  previous: string | number | null;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  assets: string[];
  source: string;
  url: string;
}

export interface CryptoNewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string | null;
  summary: string;
}

export type NewsStatus = 'LIVE' | 'DEGRADED' | 'UNAVAILABLE';

const FEEDS = [
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
];

const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const DATA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/fed-events.json',
);

function loadFedEvents(): FedEvent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as { events: FedEvent[] };
    return [...raw.events].sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    return [];
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(item: string, tag: string): string | null {
  const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripHtml(m[1]) : null;
}

function parseRss(xml: string, source: string, maxItems = 15): CryptoNewsItem[] {
  const items: CryptoNewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks.slice(0, maxItems)) {
    const title = tagText(block, 'title');
    const link = tagText(block, 'link') ?? tagText(block, 'guid');
    if (!title || !link) continue;
    const pub = tagText(block, 'pubDate');
    const desc = tagText(block, 'description');
    items.push({
      title,
      source,
      url: link,
      publishedAt: pub ? new Date(pub).toISOString() : null,
      summary: desc ? desc.slice(0, 220) : '',
    });
  }
  return items;
}

let cache: { items: CryptoNewsItem[]; fetchedAt: number; okFeeds: number } | null = null;

async function fetchFeed(feed: (typeof FEEDS)[number]): Promise<CryptoNewsItem[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'CTIT-Terminal/0.1 (news reader)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml, feed.source);
  } finally {
    clearTimeout(timer);
  }
}

export async function getNews(): Promise<{
  updatedAt: string;
  fedEvents: FedEvent[];
  cryptoNews: CryptoNewsItem[];
  status: NewsStatus;
}> {
  const fedEvents = loadFedEvents();
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return {
      updatedAt: new Date(cache.fetchedAt).toISOString(),
      fedEvents,
      cryptoNews: cache.items,
      status: cache.okFeeds === FEEDS.length ? 'LIVE' : cache.okFeeds > 0 ? 'DEGRADED' : 'UNAVAILABLE',
    };
  }

  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f)));
  const items: CryptoNewsItem[] = [];
  let okFeeds = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      okFeeds += 1;
      items.push(...r.value);
    }
  }
  items.sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });

  if (items.length > 0) {
    cache = { items: items.slice(0, 30), fetchedAt: now, okFeeds };
    return {
      updatedAt: new Date(now).toISOString(),
      fedEvents,
      cryptoNews: cache.items,
      status: okFeeds === FEEDS.length ? 'LIVE' : 'DEGRADED',
    };
  }

  // Both feeds failed: serve stale cache if we have it, else UNAVAILABLE.
  if (cache) {
    return {
      updatedAt: new Date(cache.fetchedAt).toISOString(),
      fedEvents,
      cryptoNews: cache.items,
      status: 'DEGRADED',
    };
  }
  return { updatedAt: new Date(now).toISOString(), fedEvents, cryptoNews: [], status: 'UNAVAILABLE' };
}
