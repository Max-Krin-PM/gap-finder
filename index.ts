import express from "express";
import axios from "axios";
import * as dotenv from "dotenv";
import path from "path";
import { detect } from "tinyld";

dotenv.config();

const app = express();
const PORT = 3000;
const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function extractChannelId(url: string): { idOrHandle: string; isHandle: boolean } | null {
  const channelMatch = url.match(/channel\/([a-zA-Z0-9_-]+)/);
  if (channelMatch) return { idOrHandle: channelMatch[1], isHandle: false };
  const handleMatch = url.match(/@([a-zA-Z0-9_-]+)/);
  if (handleMatch) return { idOrHandle: handleMatch[1], isHandle: true };
  return null;
}

async function getChannelInfo(idOrHandle: string, isHandle: boolean) {
  const params: any = { part: "snippet,statistics", key: YT_API_KEY };
  if (isHandle) params.forHandle = idOrHandle;
  else params.id = idOrHandle;
  const response = await axios.get("https://www.googleapis.com/youtube/v3/channels", { params });
  return response.data.items?.[0] || null;
}

// --- ОПРЕДЕЛЕНИЕ ЯЗЫКА КАНАЛА (ЛОКАЛЬНО) ---
function isChannelInTargetLanguage(
  title: string,
  description: string,
  targetLang: string
): boolean {
  const text = [title, description].filter(Boolean).join(" ").trim();
  if (text.length < 10) return false;

  let score = 0;
  try {
    const detected = detect(text);
    if (detected === targetLang) score += 2;
  } catch {}

  if (targetLang === "ru") {
    const cyrillicCount = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
    if (cyrillicCount / text.length > 0.25) score += 1;
    if (/\b(это|как|что|новости|обзор|игра|влог)\b/i.test(text)) score += 1;
  }
  if (targetLang === "es") {
    if (/[áéíóúñ¿¡]/i.test(text)) score += 1;
    if (/\b(que|como|para|noticias|juego|vlog)\b/i.test(text)) score += 1;
  }
  if (targetLang === "en") {
    if (/\b(the|and|this|news|game|vlog|official)\b/i.test(text)) score += 1;
  }
  return score >= 2;
}

// --- ПОЛУЧЕНИЕ ПОДПИСЧИКОВ ЧЕРЕЗ YOUTUBE API (1 юнит) ---
async function fetchSubscribersViaYouTubeApi(channelIds: string[]): Promise<Record<string, number>> {
  if (channelIds.length === 0) return {};
  
  try {
    // YouTube API позволяет запросить до 50 ID за раз (1 юнит квоты)
    const response = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      params: {
        part: "statistics",
        id: channelIds.join(","),
        key: YT_API_KEY
      }
    });

    const subsMap: Record<string, number> = {};
    for (const item of response.data.items || []) {
      subsMap[item.id] = Number(item.statistics.subscriberCount) || 0;
    }
    return subsMap;
  } catch (e: any) {
    console.error("Ошибка получения подписчиков из YouTube API:", e.message);
    return {};
  }
}

// --- ПОИСК КАНАЛОВ ЧЕРЕЗ TRYSMARTAPI ---
interface TrySmartChannelRow {
  channelId?: string;
  channelName?: string;
  channelTitle?: string;
  title?: string;
  description?: string;
  channelUrl?: string;
  [key: string]: any;
}

async function searchChannelsViaTrySmartApi(nicheQuery: string): Promise<TrySmartChannelRow[]> {
  const runUrl = "https://api.apify.com/v2/acts/trysmartapi~youtube-scraper/run-sync-get-dataset-items";

  const payload = {
    operation: "search_channels",
    queries: [nicheQuery],
    maxItems: 50,
    regionCode: "US",
  };

  const response = await axios.post(runUrl, payload, {
    headers: {
      Authorization: `Bearer ${APIFY_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 60000,
  });

  return response.data || [];
}

async function searchCompetitorsInLanguage(
  nicheQuery: string,
  langCode: string
): Promise<{ title: string; subscribers: number; url: string }[]> {
  let candidates: TrySmartChannelRow[] = [];
  try {
    candidates = await searchChannelsViaTrySmartApi(nicheQuery);
  } catch (e: any) {
    console.error(`Ошибка Apify (trysmartapi) для ${langCode}:`, e.message);
    return [];
  }

  if (candidates.length === 0) return [];

  // 1. Фильтруем по языку
  const filtered = candidates.filter((ch) => {
    const title = ch.channelName || ch.channelTitle || ch.title || "";
    const desc = ch.description || "";
    return isChannelInTargetLanguage(title, desc, langCode);
  });

  if (filtered.length === 0) return [];

  // 2. Собираем ID каналов, прошедших фильтр
  const validChannelIds = filtered
    .map(ch => ch.channelId)
    .filter((id): id is string => Boolean(id));

  // 3. Идем в YouTube API за подписчиками (1 юнит квоты)
  const subsMap = await fetchSubscribersViaYouTubeApi(validChannelIds);

  // 4. Формируем финальный ответ
  return filtered
    .map((ch) => {
      const title = ch.channelName || ch.channelTitle || ch.title || "Unknown";
      const id = ch.channelId || "";
      const subscribers = id ? (subsMap[id] || 0) : 0;
      const url = ch.channelUrl || (id ? `https://youtube.com/channel/${id}` : "");
      return { title, subscribers, url };
    })
    .filter((ch) => ch.url)
    .sort((a, b) => b.subscribers - a.subscribers)
    .slice(0, 20);
}

// --- ШАГ 1: ПОЛУЧЕНИЕ ИНФО О КАНАЛЕ ---
async function getInitialChannelInfo(channelUrl: string) {
  const parsed = extractChannelId(channelUrl);
  if (!parsed) throw new Error("Неверный формат ссылки.");

  const channelInfo = await getChannelInfo(parsed.idOrHandle, parsed.isHandle);
  if (!channelInfo) throw new Error("Канал не найден");

  return {
    channelId: channelInfo.id,
    channelName: channelInfo.snippet.title,
    niche: channelInfo.snippet.title.replace(/[^\w\sа-яА-Я]/gi, "").trim(),
  };
}

// --- ТРЕНДЫ ---
async function getTrendingVideosViaApify() {
  if (!APIFY_TOKEN) throw new Error("Apify token не найден в .env");
  const runUrl = "https://api.apify.com/v2/acts/api-ninja~youtube-search-scraper/run-sync-get-dataset-items";

  const payload = {
    query: "AI news",
    maxResultsPerQuery: 20,
    type: "video",
    sortBy: "popularity",
    uploadDate: "week",
    country: "US",
  };

  try {
    const response = await axios.post(runUrl, payload, {
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
    });

    const videos = response.data || [];
    if (videos.length === 0) return { videos: [] };

    return {
      videos: videos
        .map((v: any) => ({
          id: v.videoId,
          title: v.title,
          channelTitle: v.channelTitle,
          channelId: v.channelId,
          views: Number(v.viewCount),
          publishedText: v.publishedTimeText,
          url: `https://youtube.com/watch?v=${v.videoId}`,
        }))
        .sort((a: any, b: any) => b.views - a.views)
        .slice(0, 20),
    };
  } catch (error: any) {
    throw new Error(error.response?.data?.error?.message || "Ошибка при запросе к Apify");
  }
}

// --- ЭНДПОИНТЫ ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public.html"));
});

app.get("/api/channel-info", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: "Укажите параметр ?url=ссылка" });
  try {
    res.json(await getInitialChannelInfo(url));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/search-by-language", async (req, res) => {
  const { niche, lang } = req.query;
  if (!niche || !lang) return res.status(400).json({ error: "Укажите параметры ?niche=...&lang=..." });

  try {
    const result = await searchCompetitorsInLanguage(niche as string, lang as string);
    res.json({ channels: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/top-new-channels", async (req, res) => {
  try {
    res.json(await getTrendingVideosViaApify());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});