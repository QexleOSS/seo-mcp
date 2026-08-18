import { isArray, isRecord, numberValue, type JsonObject } from "./json.ts";

export async function checkTraffic(
  token: string,
  domainOrUrl: string,
  mode: "subdomains" | "exact" = "subdomains",
  country = "None",
): Promise<JsonObject | null> {
  if (!token) return null;
  const input = JSON.stringify({
    captcha: token,
    country,
    protocol: "None",
    mode,
    url: domainOrUrl,
  });
  try {
    const query = new URLSearchParams({ input }).toString();
    const response = await fetch(
      `https://ahrefs.com/v4/stGetFreeTrafficOverview?${query}`,
      {
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          referer: `https://ahrefs.com/traffic-checker/?input=${domainOrUrl}&mode=${mode}`,
        },
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
    const traffic = isRecord(data[1].traffic) ? data[1].traffic : {};
    return {
      traffic_history: data[1].traffic_history ?? [],
      traffic: {
        trafficMonthlyAvg: numberValue(traffic.trafficMonthlyAvg),
        costMontlyAvg: numberValue(traffic.costMontlyAvg),
      },
      top_pages: data[1].top_pages ?? [],
      top_countries: data[1].top_countries ?? [],
      top_keywords: data[1].top_keywords ?? [],
    };
  } catch {
    return null;
  }
}
