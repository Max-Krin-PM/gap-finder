import express from "express";
import axios from "axios";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config();

const app = express();
const PORT = 3000;
const API_KEY = process.env.YOUTUBE_API_KEY;

// Функция поиска каналов по нише
async function searchChannelsByNiche(query: string) {
  const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
    params: {
      part: "snippet",
      q: query,
      type: "channel",
      maxResults: 50,
      key: API_KEY,
    },
  });
  return response.data.items || [];
}

// Функция получения деталей по списку ID
async function getChannelsDetails(channelIds: string[]) {
  if (channelIds.length === 0) return [];
  const response = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
    params: {
      part: "snippet,statistics",
      id: channelIds.join(","),
      key: API_KEY,
    },
  });
  return response.data.items || [];
}

// Функция анализа одной ниши
async function analyzeNiche(query: string) {
  const searchItems = await searchChannelsByNiche(query);
  const channelIds = searchItems.map((item: any) => item.id.channelId);
  const channels = await getChannelsDetails(channelIds);
  
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

  let newChannelsCount = 0;
  let totalViewsOfNewChannels = 0;
  const newChannelsList: any[] = [];

  channels.forEach((channel: any) => {
    const createdAt = new Date(channel.snippet.publishedAt);
    const views = Number(channel.statistics.viewCount);
    
    if (createdAt > twoMonthsAgo) {
      newChannelsCount++;
      totalViewsOfNewChannels += views;
      newChannelsList.push({
        title: channel.snippet.title,
        createdAt: channel.snippet.publishedAt,
        views: views,
        id: channel.id
      });
    }
  });

  const index = newChannelsCount > 0 ? Math.round(totalViewsOfNewChannels / newChannelsCount) : 0;

  return {
    query,
    totalChannels: channels.length,
    newChannelsCount,
    index,
    newChannels: newChannelsList
  };
}

// Отдаем HTML-файл на главной странице
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public.html"));
});

// API для анализа
app.get("/api/analyze", async (req, res) => {
  const query = req.query.q as string;

  if (!query) {
    return res.status(400).json({ error: "Укажите параметр ?q=название ниши" });
  }

  try {
    const result = await analyzeNiche(query);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Пример запроса: http://localhost:${PORT}/api/analyze?q=Cursor AI coding`);
});