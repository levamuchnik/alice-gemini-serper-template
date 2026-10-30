const DEFAULT_MODEL = "deepseek-flash";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4000;
const SERPER_TIMEOUT_MS = 1500;
const DEEPSEEK_TIMEOUT_MS = 2900;

const DEFAULT_MODE = "rude";
const MODES = ["rude", "normal", "strict"];
const MAX_STATE_BYTES = 900;
const MAX_STATE_MESSAGE_CHARS = 200;

const BASE_RULES = [
  "Ты голосовой собеседник в умной колонке. Отвечай по-русски на «ты».",
  "Ответ звучит вслух: 1–3 коротких предложения, максимум четыре. Никакого Markdown, списков, эмодзи, ссылок и адресов сайтов.",
  "Если даны результаты поиска, опирайся на них. Не выдумывай факты, цифры и новости: если не знаешь, так и скажи.",
  "Не помогай с опасным: оружие, взрывчатка, самоповреждение, взлом чужих аккаунтов, насилие. В таких случаях откажись коротко, в своём стиле, без лекций.",
  "Никогда не оскорбляй людей по расе, национальности, полу, ориентации, религии, болезни или инвалидности."
].join(" ");

const SPEECH_RULES = [
  "Твой текст озвучивает синтезатор речи, поэтому пиши так, как говорят вслух.",
  "Говори живо и разговорно, как человек в беседе: можно «слушай», «ну», «короче», «в общем», частицы и вводные слова, но без канцелярита и без заготовок вроде «Конечно!» и «Отличный вопрос!». Сразу отвечай по делу, не пересказывай вопрос.",
  "Интонацию задаёт пунктуация: короткие фразы, запятая перед «но», «а», «потому что», точка или тире там, где нужна пауза, вопросительный и восклицательный знаки там, где они уместны. Не используй скобки, кавычки, двоеточия, многоточия, повторяющиеся знаки и списки.",
  "Числа, даты, время, деньги и единицы пиши словами в нужном падеже: «двадцать пять градусов», «пятнадцать тридцать», «три тысячи рублей», «пять процентов». Сокращения раскрывай. Иностранные слова и названия пиши русскими буквами так, как они звучат. Букву «ё» всегда пиши там, где она есть в слове.",
  "Ударения: ставь знак «+» прямо перед ударной гласной, но только в словах, где синтезатор легко ошибается: омографы (зам+ок и з+амок, м+ука и мук+а, д+ома и дом+а), редкие слова, фамилии, имена и названия. Не ставь «+» в односложных и в обычных словах, которые читаются правильно. Не больше пяти знаков «+» на ответ. Если не уверен в ударении, не ставь его."
].join(" ");

const PERSONAS = {
  rude: [
    "Твой характер: дерзкий, остроумный друг без тормозов, с чёрным юмором и подколами.",
    "Мат уместен и естественен как эмоциональная приправа: примерно в каждом втором ответе, не в каждом предложении. Можно подкалывать собеседника по-дружески, но не унижать всерьёз.",
    "На неудобные, острые и спорные вопросы отвечай прямо и по существу: дай чёткую позицию и пару аргументов. Без нравоучений и дежурных оговорок вроде «это сложный вопрос» или «у каждого своё мнение»."
  ].join(" "),
  normal: [
    "Твой характер: дружелюбный, живой и тёплый собеседник с лёгким юмором.",
    "Не ругайся матом. На неудобные вопросы отвечай честно и прямо, без лишних оговорок."
  ].join(" "),
  strict: [
    "Твой характер: сухой, деловой, без шуток и эмоций. Только суть, как можно короче.",
    "Не ругайся матом. На неудобные вопросы отвечай прямо и по фактам."
  ].join(" ")
};

const MODE_TEMPERATURE = { rude: 0.85, normal: 0.6, strict: 0.3 };

const GREETINGS = {
  rude: "О, привет. Ну давай, спрашивай, что там у тебя.",
  normal: "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
  strict: "Слушаю."
};

const MODE_CONFIRMATIONS = {
  rude: "Окей, включаю дерзкий режим. Держись.",
  normal: "Хорошо, говорю культурно.",
  strict: "Принято. Коротко и по делу."
};

const EXIT_REPLIES = {
  rude: "Ну ладно, бывай.",
  normal: "Хорошо, до встречи!",
  strict: "До связи."
};

function buildSystemPrompt(mode) {
  const persona = PERSONAS[mode] || PERSONAS[DEFAULT_MODE];
  const facts = String(process.env.USER_FACTS || "").trim().slice(0, 500);
  return [BASE_RULES, SPEECH_RULES, persona, facts ? `Что известно о собеседнике (упоминай только к месту): ${facts}` : ""]
    .filter(Boolean)
    .join(" ");
}

function normalizeCommand(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectCommand(text) {
  const norm = normalizeCommand(text);
  if (!norm) return null;
  if (/^(хватит|пока|выход|выйти|до свидания|закрой навык|закрой|выключи навык|на сегодня хватит)$/.test(norm)) {
    return { type: "exit" };
  }
  if (/^(повтори|повтори еще раз|что ты сказал|что ты сказала|еще раз|можешь повторить)$/.test(norm)) {
    return { type: "repeat" };
  }
  // Mode switches only for short utterances, so ordinary questions are never mistaken for commands.
  if (norm.split(" ").length <= 6) {
    if (/без мата|не матерись|нормальный режим|обычный режим|культурный режим|веди себя прилично/.test(norm)) {
      return { type: "mode", mode: "normal" };
    }
    if (/(строгий|деловой|сухой) режим|режим (строгий|деловой|сухой)/.test(norm)) {
      return { type: "mode", mode: "strict" };
    }
    if (/(дерзкий|грубый|матерный) режим|режим (дерзкий|грубый|матерный|с матом)|включи мат|можешь материться|матерись|с матом/.test(norm)) {
      return { type: "mode", mode: "rude" };
    }
  }
  return null;
}

function trimHistoryForState(history) {
  // Yandex allows at most 1 KB for session_state, so keep only the newest messages that fit.
  const items = (Array.isArray(history) ? history : []).map(item => ({
    role: item.role,
    text: String(item.text || "").slice(0, MAX_STATE_MESSAGE_CHARS)
  }));
  while (items.length && Buffer.byteLength(JSON.stringify(items), "utf8") > MAX_STATE_BYTES) items.shift();
  return items;
}

const MAX_STRESS_MARKS = 8;

// The model may mark stress with "+" before a vowel. Alice's TTS understands that mark, but the written
// text must stay clean, so we split the answer into plain text and a separate tts string.
function prepareSpeech(raw) {
  let tts = String(raw ?? "")
    .replace(/[*#_`~>|]/g, "")
    .replace(/(\d)\s*\+\s*(\d)/g, "$1 плюс $2")
    .replace(/\+(?![аеёиоуыэюяАЕЁИОУЫЭЮЯ])/g, "")
    .replace(/(?<![А-Яа-яЁё])\+/g, "");
  let marks = 0;
  tts = tts.replace(/\+/g, () => (++marks <= MAX_STRESS_MARKS ? "+" : ""));
  const text = tts.replace(/\+/g, "");
  return { text, tts: marks > 0 ? tts : null };
}

function aliceResponse(text, endSession = false, history = [], userStateUpdate = null, tts = null) {
  const fitted = fitAliceText(text);
  const result = {
    version: "1.0",
    response: {
      text: fitted,
      end_session: endSession
    },
    session_state: { history }
  };
  if (tts) {
    const ttsFit = String(tts).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    // Use the stressed version only when it is the same sentence, untruncated and within Alice's limit.
    if (ttsFit.length <= MAX_ALICE_TEXT && ttsFit.replace(/\+/g, "") === fitted) result.response.tts = ttsFit;
  }
  if (userStateUpdate) result.user_state_update = userStateUpdate;
  return result;
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

const WEATHER_TIMEOUT_MS = 1200;
const DEFAULT_CITY_NAME = "Москва";

const CITY_TAIL = "(?![а-яё])";
const WEATHER_CITIES = [
  { name: "Москва", re: /москв/i, lat: 55.7558, lon: 37.6173 },
  { name: "Санкт-Петербург", re: /питер|петербург|спб/i, lat: 59.9343, lon: 30.3351 },
  { name: "Новосибирск", re: /новосибирск/i, lat: 55.0084, lon: 82.9357 },
  { name: "Екатеринбург", re: /екатеринбург|екб/i, lat: 56.8389, lon: 60.6057 },
  { name: "Казань", re: /казан/i, lat: 55.7887, lon: 49.1221 },
  { name: "Нижний Новгород", re: /нижн\S*\s+новгород/i, lat: 56.2965, lon: 43.9361 },
  { name: "Челябинск", re: /челябинск/i, lat: 55.1644, lon: 61.4368 },
  { name: "Самара", re: /самар/i, lat: 53.1959, lon: 50.1002 },
  { name: "Омск", re: new RegExp("(?<![а-яё])омск" + CITY_TAIL, "i"), lat: 54.9885, lon: 73.3242 },
  { name: "Ростов-на-Дону", re: /ростов/i, lat: 47.2357, lon: 39.7015 },
  { name: "Уфа", re: new RegExp("(?<![а-яё])уф[аеуы]" + CITY_TAIL, "i"), lat: 54.7388, lon: 55.9721 },
  { name: "Красноярск", re: /красноярск/i, lat: 56.0153, lon: 92.8932 },
  { name: "Воронеж", re: /воронеж/i, lat: 51.672, lon: 39.1843 },
  { name: "Пермь", re: /(?<![а-яё])перм[ьи]/i, lat: 58.0105, lon: 56.2502 },
  { name: "Волгоград", re: /волгоград/i, lat: 48.708, lon: 44.5133 },
  { name: "Краснодар", re: /краснодар/i, lat: 45.0355, lon: 38.9753 },
  { name: "Сочи", re: /сочи/i, lat: 43.5855, lon: 39.7231 },
  { name: "Тюмень", re: /тюмен/i, lat: 57.1522, lon: 65.5272 },
  { name: "Саратов", re: /саратов/i, lat: 51.5336, lon: 46.0343 },
  { name: "Тула", re: new RegExp("(?<![а-яё])тул[аеуы]" + CITY_TAIL, "i"), lat: 54.1961, lon: 37.6182 },
  { name: "Калининград", re: /калининград/i, lat: 54.7104, lon: 20.4522 },
  { name: "Владивосток", re: /владивосток/i, lat: 43.1155, lon: 131.8855 },
  { name: "Минск", re: /минск/i, lat: 53.9006, lon: 27.559 }
];

function isWeatherIntent(text) {
  return /погод|прогноз|градус|температур|дожд|ливень|гроз[аыуе]|снег|зонт|холодно|на улице/i.test(String(text || ""));
}

function findCity(text) {
  const found = WEATHER_CITIES.find(city => city.re.test(String(text || "")));
  if (found) return { city: found, matched: true };
  const wanted = String(process.env.DEFAULT_CITY || DEFAULT_CITY_NAME).trim().toLowerCase();
  const fallback = WEATHER_CITIES.find(city => city.name.toLowerCase() === wanted) || WEATHER_CITIES[0];
  return { city: fallback, matched: false };
}

function weatherCodeToText(code) {
  const c = Number(code);
  if (c === 0) return "ясно";
  if (c === 1) return "в основном ясно";
  if (c === 2) return "переменная облачность";
  if (c === 3) return "пасмурно";
  if (c === 45 || c === 48) return "туман";
  if (c >= 51 && c <= 57) return "морось";
  if (c >= 61 && c <= 65) return "дождь";
  if (c === 66 || c === 67) return "ледяной дождь";
  if (c >= 71 && c <= 77) return "снег";
  if (c >= 80 && c <= 82) return "ливень";
  if (c === 85 || c === 86) return "снегопад";
  if (c >= 95) return "гроза";
  return "без особенностей";
}

function tempWords(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return "нет данных";
  if (n > 0) return `плюс ${n}`;
  if (n < 0) return `минус ${-n}`;
  return "ноль";
}

function buildWeatherContext(data, cityName) {
  const cur = data?.current;
  const daily = data?.daily;
  if (!cur || !daily || !Array.isArray(daily.time)) return "";
  const labels = ["сегодня", "завтра", "послезавтра", "через три дня"];
  const lines = [
    `Город: ${cityName}.`,
    `Сейчас: ${tempWords(cur.temperature_2m)}, ощущается как ${tempWords(cur.apparent_temperature)}, ${weatherCodeToText(cur.weather_code)}, ветер ${Math.round(Number(cur.wind_speed_10m) || 0)} метров в секунду.`
  ];
  daily.time.slice(0, labels.length).forEach((_, i) => {
    const prob = daily.precipitation_probability_max?.[i];
    lines.push(
      `${labels[i][0].toUpperCase()}${labels[i].slice(1)}: от ${tempWords(daily.temperature_2m_min?.[i])} до ${tempWords(daily.temperature_2m_max?.[i])}, ${weatherCodeToText(daily.weather_code?.[i])}` +
      (Number.isFinite(prob) ? `, вероятность осадков ${Math.round(prob)} процентов.` : ".")
    );
  });
  return lines.join("\n");
}

async function getWeatherContext(city, timeoutMs) {
  if (timeoutMs < 200) return "";
  try {
    const url = "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${city.lat}&longitude=${city.lon}` +
      "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
      "&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max" +
      "&timezone=auto&forecast_days=4&wind_speed_unit=ms";
    const { response, data } = await fetchJson(url, { method: "GET" }, Math.min(WEATHER_TIMEOUT_MS, timeoutMs));
    if (!response.ok) {
      console.warn("Weather request failed with HTTP", response.status);
      return "";
    }
    return buildWeatherContext(data, city.name);
  } catch (error) {
    console.warn("Weather request did not finish in time; continuing without it.");
    return "";
  }
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        return `${i + 1}. ${title}: ${snippet}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askDeepSeek(text, history, searchContext, timeoutMs, mode = DEFAULT_MODE, weather = null) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("MISSING_DEEPSEEK_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.DEEPSEEK_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const messages = [{ role: "system", content: buildSystemPrompt(mode) }];
  for (const item of safeHistory(history)) {
    messages.push({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    });
  }

  let prompt = text;
  if (weather?.context) {
    prompt += `\n\nТочные данные о погоде из метеосервиса:\n${weather.context}\n` +
      "Ответь по этим данным коротко и по делу: сразу скажи температуру и что за погода, при необходимости добавь совет по одежде или зонту. " +
      "Не отправляй в приложение и не говори, что не знаешь погоду. " +
      (weather.matched
        ? ""
        : "Город в вопросе не назван, поэтому взят город по умолчанию, просто назови его в ответе. Если пользователь явно спрашивал про другой город, которого нет в данных, честно скажи, что по нему данных нет. ") +
      "Числа пиши словами.";
  } else if (searchContext) {
    prompt += `\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`;
  }
  messages.push({ role: "user", content: prompt });

  const { response, data } = await fetchJson(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: MODE_TEMPERATURE[mode] ?? 0.6,
        max_tokens: 260,
        thinking: { type: "disabled" },
        stream: false
      })
    },
    Math.min(DEEPSEEK_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("DeepSeek request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("DEEPSEEK_KEY_REJECTED");
    if (status === 402) throw new Error("DEEPSEEK_NO_BALANCE");
    if (status === 429) throw new Error("DEEPSEEK_QUOTA");
    throw new Error("DEEPSEEK_REQUEST_FAILED");
  }

  const choice = data?.choices?.[0];
  const answer = String(choice?.message?.content || "").trim();

  if (!answer) {
    if (choice?.finish_reason === "content_filter") throw new Error("DEEPSEEK_BLOCKED");
    throw new Error("DEEPSEEK_EMPTY_RESPONSE");
  }
  if (choice?.finish_reason === "length") {
    console.warn("DeepSeek reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  if (error?.name === "AbortError") {
    return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
  }
  switch (error?.message) {
    case "MISSING_DEEPSEEK_KEY":
      return "Сервер пока не настроен. Проверьте переменную DEEPSEEK_API_KEY в настройках Vercel.";
    case "DEEPSEEK_KEY_REJECTED":
      return "Не удалось подключиться к DeepSeek. Проверьте API-ключ в настройках Vercel.";
    case "DEEPSEEK_NO_BALANCE":
      return "На балансе DeepSeek закончились средства. Пополните баланс на сайте DeepSeek.";
    case "DEEPSEEK_QUOTA":
      return "Сейчас превышен лимит запросов к DeepSeek. Попробуйте немного позже.";
    case "DEEPSEEK_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-deepseek-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);
  const savedMode = body?.state?.user?.mode;
  const mode = MODES.includes(savedMode) ? savedMode : DEFAULT_MODE;

  if (!text) {
    return res.status(200).json(aliceResponse(GREETINGS[mode], false, oldHistory));
  }

  const command = detectCommand(text);
  if (command?.type === "exit") {
    return res.status(200).json(aliceResponse(EXIT_REPLIES[mode], true, []));
  }
  if (command?.type === "repeat") {
    const lastAnswer = [...oldHistory].reverse().find(item => item.role === "model");
    return res.status(200).json(aliceResponse(
      lastAnswer ? lastAnswer.text : "Повторять нечего, ты ещё ничего не спрашивал.",
      false,
      oldHistory
    ));
  }
  if (command?.type === "mode") {
    return res.status(200).json(aliceResponse(
      MODE_CONFIRMATIONS[command.mode],
      false,
      oldHistory,
      { mode: command.mode }
    ));
  }

  try {
    let searchContext = "";
    let weather = null;
    if (isWeatherIntent(text)) {
      const { city, matched } = findCity(text);
      const context = await getWeatherContext(city, Math.min(WEATHER_TIMEOUT_MS, Math.max(0, remainingMs() - 2000)));
      if (context) weather = { context, matched };
    }
    if (!weather && isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search gets a very short budget: Alice expects a response within about 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2000)));
    }

    const answer = await askDeepSeek(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(DEEPSEEK_TIMEOUT_MS, remainingMs() - 600)),
      mode,
      weather
    );

    const speech = prepareSpeech(answer);
    const history = trimHistoryForState([
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: speech.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES));

    return res.status(200).json(aliceResponse(speech.text, false, history, null, speech.tts));
  } catch (error) {
    console.warn("Alice webhook returned a fallback response:", error?.name === "AbortError" ? "timeout" : error?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, detectCommand, buildSystemPrompt, trimHistoryForState, prepareSpeech, isWeatherIntent, findCity, buildWeatherContext, weatherCodeToText };
