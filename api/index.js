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
  return [BASE_RULES, persona, facts ? `Что известно о собеседнике (упоминай только к месту): ${facts}` : ""]
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

function aliceResponse(text, endSession = false, history = [], userStateUpdate = null) {
  const result = {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
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

async function askDeepSeek(text, history, searchContext, timeoutMs, mode = DEFAULT_MODE) {
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

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
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
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search gets a very short budget: Alice expects a response within about 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2000)));
    }

    const answer = await askDeepSeek(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(DEEPSEEK_TIMEOUT_MS, remainingMs() - 600)),
      mode
    );

    const history = trimHistoryForState([
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES));

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    console.warn("Alice webhook returned a fallback response:", error?.name === "AbortError" ? "timeout" : error?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, detectCommand, buildSystemPrompt, trimHistoryForState };
