import express from "express";
import axios from "axios";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config();

const app = express();
const PORT = 3000;
const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (для Раздела 1) ---
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

async function getChannelsDetails(channelIds: string[]) {
  if (channelIds.length === 0) return [];
  const response = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
    params: { part: "snippet,statistics", id: channelIds.join(","), key: YT_API_KEY },
  });
  return response.data.items || [];
}

async function isChannelActive(channelId: string) {
  try {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
      params: { part: "snippet", channelId: channelId, type: "video", publishedAfter: oneMonthAgo.toISOString(), maxResults: 1, key: YT_API_KEY },
    });
    return (response.data.items || []).length > 0;
  } catch (e) { return false; }
}

async function analyzeChannel(channelUrl: string) {
  const parsed = extractChannelId(channelUrl);
  if (!parsed) throw new Error("Неверный формат ссылки.");
  const channelInfo = await getChannelInfo(parsed.idOrHandle, parsed.isHandle);
  if (!channelInfo) throw new Error("Канал не найден");

  const nicheQuery = channelInfo.snippet.title.replace(/[^\w\sа-яА-Я]/gi, "").trim();
  const originalChannelId = channelInfo.id;
  const languages = [
    { code: "en", name: "EN" }, { code: "es", name: "ES" }, { code: "pt", name: "PT" }, 
    { code: "de", name: "DE" }, { code: "fr", name: "FR" }, { code: "hi", name: "HI" }, 
    { code: "ja", name: "JA" }, { code: "ru", name: "RU" }
  ];
  const results: any = {};

  for (const lang of languages) {
    try {
      const searchResponse = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: { part: "snippet", q: nicheQuery, type: "channel", relevanceLanguage: lang.code, maxResults: 20, key: YT_API_KEY },
      });
      const channelIds = (searchResponse.data.items || []).map((item: any) => item.id.channelId).filter((id: string) => id !== originalChannelId);
      const details = await getChannelsDetails(channelIds);
      const activeChannels = [];
      
      for (const ch of details) {
        const subs = Number(ch.statistics.subscriberCount);
        if (subs < 1000) continue;
        const active = await isChannelActive(ch.id);
        if (active) {
          activeChannels.push({ title: ch.snippet.title, subscribers: subs, id: ch.id, url: `https://youtube.com/channel/${ch.id}` });
        }
      }
      results[lang.name] = activeChannels.sort((a: any, b: any) => b.subscribers - a.subscribers).slice(0, 5);
    } catch (e) { results[lang.name] = []; }
  }
  return { channelName: channelInfo.snippet.title, niche: nicheQuery, topChannelsByLang: results };
}

// --- РАЗДЕЛ 2: ТРЕНДЫ ЧЕРЕЗ APIFY (ИСПРАВЛЕНО) ---
async function getTrendingVideosViaApify() {
  if (!APIFY_TOKEN) throw new Error("Apify token не найден в .env");

  // Правильный эндпоинт для запуска актора и получения данных
  const runUrl = "https://api.apify.com/v2/acts/api-ninja~youtube-search-scraper/run-sync-get-dataset-items";
  
  // Структура полей строго по документации api-ninja
  const payload = {
    query: "AI news",
    maxResultsPerQuery: 20,
    type: "video",
    sortBy: "popularity", // Валидное значение: relevance | popularity | upload_date
    uploadDate: "week",   // Валидное значение: hour | day | week | month | year
    country: "US"
  };

  console.log("Запускаем Apify скрапер...");
  
  try {
    const response = await axios.post(runUrl, payload, {
      headers: {
        "Authorization": `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 120000 // Ждем до 2 минут
    });

    const videos = response.data || [];

    if (videos.length === 0) {
      return { videos: [] };
    }

    // Очищаем и сортируем данные для фронтенда
    return {
      videos: videos.map((v: any) => ({
        id: v.videoId,
        title: v.title,
        channelTitle: v.channelTitle,
        channelId: v.channelId,
        views: Number(v.viewCount),
        publishedText: v.publishedTimeText,
        url: `https://youtube.com/watch?v=${v.videoId}`
      })).sort((a: any, b: any) => b.views - a.views).slice(0, 20)
    };
  } catch (error: any) {
    console.error("Детали ошибки Apify:", error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || "Ошибка при запросе к Apify");
  }
}

// --- ЭНДПОИНТЫ ---
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "public.html")); });

app.get("/api/analyze-channel", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: "Укажите параметр ?url=ссылка" });
  try { res.json(await analyzeChannel(url)); } catch (error: any) { res.status(500).json({ error: error.message }); }
});

app.get("/api/top-new-channels", async (req, res) => {
  try { res.json(await getTrendingVideosViaApify()); } catch (error: any) { res.status(500).json({ error: error.message }); }
});

app.listen(PORT, () => { console.log(`Сервер запущен: http://localhost:${PORT}`); });