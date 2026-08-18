import {
  isArray,
  isRecord,
  numberValue,
  stringValue,
  type JsonObject,
} from "./json.ts";

const NO_IDEAS = "\n❌ No valid keyword ideas retrieved";

export function formatKeywordIdeas(
  keywordData: unknown,
): JsonObject[] | [string] {
  if (
    !isArray(keywordData) ||
    keywordData.length < 2 ||
    !isRecord(keywordData[1])
  )
    return [NO_IDEAS];
  const result: JsonObject[] = [];
  for (const [key, label] of [
    ["allIdeas", "keyword ideas"],
    ["questionIdeas", "question ideas"],
  ] as const) {
    const section = keywordData[1][key];
    if (!isRecord(section) || !isArray(section.results)) continue;
    for (const idea of section.results.filter(isRecord)) {
      result.push({
        label,
        value: {
          keyword: stringValue(idea.keyword, "No keyword"),
          country: stringValue(idea.country, "-"),
          difficulty: stringValue(idea.difficultyLabel, "Unknown"),
          volume: stringValue(idea.volumeLabel, "Unknown"),
          updatedAt: stringValue(idea.updatedAt, "-"),
        },
      });
    }
  }
  return result.length ? result : [NO_IDEAS];
}

export async function getKeywordIdeas(
  token: string,
  keyword: string,
  country = "us",
  searchEngine = "Google",
): Promise<JsonObject[] | [string] | null> {
  if (!token) return null;
  try {
    const response = await fetch(
      "https://ahrefs.com/v4/stGetFreeKeywordIdeas",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          withQuestionIdeas: true,
          captcha: token,
          searchEngine,
          country,
          keyword: ["Some", keyword],
        }),
      },
    );
    if (response.status !== 200) return null;
    return formatKeywordIdeas(await response.json());
  } catch {
    return null;
  }
}

export async function getKeywordDifficulty(
  token: string,
  keyword: string,
  country = "us",
): Promise<JsonObject | null> {
  if (!token) return null;
  try {
    const response = await fetch(
      "https://ahrefs.com/v4/stGetFreeSerpOverviewForKeywordDifficultyChecker",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json; charset=utf-8",
          referer: `https://ahrefs.com/keyword-difficulty/?country=${country}&input=${keyword}`,
        },
        body: JSON.stringify({ captcha: token, country, keyword }),
      },
    );
    if (response.status !== 200) return null;
    const data: unknown = await response.json();
    if (
      !isArray(data) ||
      data.length < 2 ||
      data[0] !== "Ok" ||
      !isRecord(data[1])
    )
      return null;
    const kd = data[1];
    const result: JsonObject = {
      difficulty: numberValue(kd.difficulty),
      shortage: numberValue(kd.shortage),
      lastUpdate: stringValue(kd.lastUpdate),
      serp: { results: [] },
    };
    const serp = kd.serp;
    if (!isRecord(serp) || !isArray(serp.results)) return result;
    const results: JsonObject[] = [];
    for (const item of serp.results.filter(isRecord)) {
      const content = item.content;
      if (
        !isArray(content) ||
        content[0] !== "organic" ||
        !isRecord(content[1])
      )
        continue;
      const link = content[1].link;
      if (!isArray(link) || link[0] !== "Some" || !isRecord(link[1])) continue;
      const linkData = link[1];
      const url =
        isArray(linkData.url) && isRecord(linkData.url[1])
          ? stringValue(linkData.url[1].url)
          : "";
      const resultItem: JsonObject = {
        title: stringValue(linkData.title),
        url,
        position: numberValue(item.pos),
      };
      if (isRecord(linkData.metrics)) {
        Object.assign(resultItem, {
          domainRating: numberValue(linkData.metrics.domainRating),
          urlRating: numberValue(linkData.metrics.urlRating),
          traffic: numberValue(linkData.metrics.traffic),
          keywords: numberValue(linkData.metrics.keywords),
          topKeyword: stringValue(linkData.metrics.topKeyword),
          topVolume: numberValue(linkData.metrics.topVolume),
        });
      }
      results.push(resultItem);
    }
    (result.serp as JsonObject).results = results;
    return result;
  } catch {
    return null;
  }
}
