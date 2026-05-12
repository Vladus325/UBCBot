const fs = require('fs');
const db = require('./database');
const { timeoutUser, toggleReward } = require('./twitchApi');
const musicQueue = require('../music/musicQueue');
const fetch = require('node-fetch');
let commands = {};

const SKIP_COSTS = { 1: 1, 2: 3, 3: 5 };

const compliments = JSON.parse(
    fs.readFileSync('./src/config/compliments.json', 'utf-8')
);

// =========================
// Загрузка команд
// =========================
function loadCommands(filePath = 'src/config/commands.json') {
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        commands = JSON.parse(data);
    } catch (err) {
        console.error("❌ Ошибка при загрузке команд:", err);
        commands = {};
    }
}

// =========================
// Основные методы
// =========================
function getCommands() {
    return commands;
}

function hasCommand(name) {
    return !!commands[name.toLowerCase()];
}

// Главная функция получения ответа
async function getCommandResponse(name, tags, channel, args = []) {
    let response = commands[name.toLowerCase()];
    if (!response) return null;

    // Обработка
    response = await processText(response, tags, channel, args);

    return response;
}

// =========================
// Обработка
// =========================
function processRollCommand(value, tags) {
    const max = parseInt(value) || 6;
    const user = tags.username;
    const r = Math.floor(Math.random() * max) + 1;

    if (max === 20) {
        if (r === 1) {
            const luckPoints = db.getLuckPoints(user);
            if (luckPoints > 0) {
                db.removeLuckPoint(1, user);
                return `${user} бросает к20: 1 — 💀 Очки удачи уменьшены... Осталось: ${luckPoints - 1} 🍀`;
            } else if (tags.mod || tags.badges?.broadcaster) {
                return `${user} бросает к20: 1 — 💀 Но ты слишком важный 😎`;
            } else {
                timeoutUser({
                    broadcasterId: process.env.BROADCASTER_ID,
                    moderatorId: process.env.MODERATOR_ID,
                    userId: tags['user-id'],
                    duration: 60,
                    accessToken: process.env.TWITCH_TOKEN,
                    clientId: process.env.CLIENT_ID
                }).catch(err => console.error('Timeout error:', err));
                return `${user} бросает к20: 1 — 💀 Критическая неудача! Мут на 1 минуту ⛔`;
            }
        } else if (r === 20) {
            db.addLuckPoint(1, user);
            const luckPoints = db.getLuckPoints(user);
            return `${user} бросает к20: 20 — 🔥 Критический успех! Очки удачи увеличены... (+1) 🍀 (всего: ${luckPoints})`;
        } else {
            return `${user} бросает к20: ${r}`;
        }
    } else if (max === 100) {
        if (r === 1) {
            if (tags.mod || tags.badges?.broadcaster) {
                return `${user} бросает к100: 1 — 💀 Но ты слишком важный 😎`;
            } else {
                const luckPoints = db.getLuckPoints(user);
                if (luckPoints > 0) db.removeLuckPoint(luckPoints, user);
                timeoutUser({
                    broadcasterId: process.env.BROADCASTER_ID,
                    moderatorId: process.env.MODERATOR_ID,
                    userId: tags['user-id'],
                    duration: 600,
                    accessToken: process.env.TWITCH_TOKEN,
                    clientId: process.env.CLIENT_ID
                }).catch(err => console.error('Timeout error:', err));
                return `${user} бросает к100: 1 — 💀 КРИТИЧЕСКАЯ НЕУДАЧА! Мут на 10 минут ⛔, потеря всех очков удачи... 🍀`;
            }
        } else if (r === 100) {
            db.addLuckPoint(10, user);
            const luckPoints = db.getLuckPoints(user);
            return `${user} бросает к100: 100 — 🔥 КРИТИЧЕСКИЙ УСПЕХ! Очки удачи увеличены... (+10) 🍀 (всего: ${luckPoints})`;
        } else {
            return `${user} бросает к100: ${r}`;
        }
    } else {
        return `${user} бросает к${max}: ${r}`;
    }
}

async function processBotAnswerCommand(args, tags) {
    const userMessage = args.join(' ').trim();
    if (userMessage) {
        // Проверка на запрещённые темы
        const forbiddenWords = /\b(timeout|ban|mute|hack|ddos|взлом|спам|флуд|ботнет|вирус|троян|злоупотребление|abuse|exploit|cheat|скрипт|script|инъекция|injection|sql|хак|phishing|фишинг|scam|мошенничество|fraud|порно|porn|nsfw|adult|секс|sex|наркотики|drugs|weapon|терроризм|terrorism|убийство|murder|самоубийство|suicide|насилие|violence|расизм|racism|дискриминация|discrimination|фейк|fake|lie|пропаганда|propaganda|негр)\b/i;
        if (forbiddenWords.test(userMessage)) {
            return `${tags.username}, извини, но я не могу помогать с такими вещами 😅`;
        } else {
            try {
                const aiResponse = await getAIResponse(userMessage, tags.username);
                return `${aiResponse}`;
            } catch (err) {
                console.error('AI error:', err);
                return `${tags.username}, извини, нейросеть не отвечает 😅`;
            }
        }
    } else {
        const randomAnswers = [
            'Привет! Чем могу помочь?',
            'Я бот, созданный для развлечения на стриме!',
            'Спроси что-нибудь интересное!',
            'Я могу отвечать на вопросы через ИИ!'
        ];
        return `${tags.username}, ${randomAnswers[Math.floor(Math.random() * randomAnswers.length)]}`;
    }
}

async function processText(text, tags, channel, args = []) {
    // Сначала простые замены
    text = text
        .replaceAll("{user}", tags.username)
        .replaceAll("{channel}", channel.replace('#', ''))
        .replaceAll("{displayName}", tags['display-name'] || tags.username);

    // Найти все плейсхолдеры {command:value}
    const placeholders = [];
    text = text.replace(/\{(\w+):?(\d+)?\}/g, (match, command, value) => {
        placeholders.push({ match, command, value });
        return `__PLACEHOLDER_${placeholders.length - 1}__`;
    });

    // Обработать каждый плейсхолдер асинхронно
    for (let i = 0; i < placeholders.length; i++) {
        const { command, value } = placeholders[i];
        let replacement = '';

        switch (command) {
            case 'roll': {
                replacement = processRollCommand(value, tags);
                break;
            }

            case 'luckpoints': {
                const luckPoints = db.getLuckPoints(tags.username);
                replacement = `${tags.username}, твоя удача измеряется в: ${luckPoints} 🍀`;
                break;
            }

            case 'compliment': {
                replacement = `${tags.username}, ${getRandomCompliment()}`;
                break;
            }

            case 'vrmode': {
                const arg = (args.join(' ').trim().toLowerCase() === "false" 
                || args.join(' ').trim().toLowerCase() === "off" 
                || args.join(' ').trim().toLowerCase() === "disable");

                if (tags.mod || tags.badges?.broadcaster) {
                    handleMode(V_REWARDS, arg);
                    handleMode(SR_REWARDS, !arg);
                    replacement = `${tags.username}, VR Режим: ${arg ? 'Выключен' : 'Включён'}`;
                }
                break; 
            }

            case 'srmode': {
                const arg = (args.join(' ').trim().toLowerCase() === "true" 
                || args.join(' ').trim().toLowerCase() === "on" 
                || args.join(' ').trim().toLowerCase() === "enable");
                
                if (tags.mod || tags.badges?.broadcaster) {
                    handleMode(SR_REWARDS, arg);
                    replacement = `${tags.username}, SR Режим: ${arg ? 'Включён' : 'Выключен'}`;
                }
                break;
            }

            case 'skip': {
                if (!musicQueue.current) replacement = 'Нечего пропускать';
                else if (tags.mod || tags.badges?.broadcaster) {
                    musicQueue.skip();
                    replacement = '⏭ Пропущено модератором';
                } else {
                    const skipCost = SKIP_COSTS[musicQueue.current.level];
                    const luckPoints = db.getLuckPoints(tags.username);
                    if (luckPoints >= skipCost) {
                        db.removeLuckPoint(skipCost, tags.username);
                        musicQueue.skip();
                        replacement = `⏭ Пропущено за ${skipCost} 🍀 (осталось: ${luckPoints - skipCost})`;
                    } else {
                        replacement = `Недостаточно очков удачи для пропуска (нужен ${skipCost} 🍀)`;
                    }
                }
                break;
            }

            case 'np': {
                const state = musicQueue.getState();
                if (!state) replacement = 'Сейчас ничего не играет';
                else replacement = `🎵 Сейчас: ${state.title} (${state.requestedBy})`;
                break;
            }

            case 'pause': {
                if (tags.mod || tags.badges?.broadcaster) {
                    if (!musicQueue.current) replacement = 'Нечего ставить на паузу';
                    else if (musicQueue.isPaused) replacement = 'Уже на паузе';
                    else {
                        musicQueue.pause();
                        replacement = '⏸ Пауза';
                    }
                }
                break;
            }

            case 'play': {
                if (tags.mod || tags.badges?.broadcaster) {
                    if (!musicQueue.current) replacement = 'Нечего возобновлять';
                    else if (!musicQueue.isPaused) replacement = 'Уже играет';
                    else {
                        musicQueue.play();
                        replacement = '▶ Возобновлено';
                    }
                }
                break;
            }

            case 'botAnswer': {
                replacement = await processBotAnswerCommand(args, tags);
                break;
            }

            default:
                replacement = '';
        }

        text = text.replace(`__PLACEHOLDER_${i}__`, replacement);
    }

    return text;
}

async function getAIResponse(message, username) {
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
        throw new Error('AI_API_KEY not set');
    }

    // Читаем промпт из файла
    let systemPrompt;
    try {
        systemPrompt = fs.readFileSync('./src/config/ai_prompt.txt', 'utf-8').trim();
    } catch (err) {
        console.error('Ошибка чтения ai_prompt.txt:', err);
        systemPrompt = 'Ты — дружелюбный чат-бот на Twitch. Отвечай коротко и по-русски.';
    }

    // Добавляем информацию о пользователе в начало сообщения
    const userMessageWithContext = `[Сообщение от ${username}]: ${message}`;

    const response = await fetch(process.env.AI_BASE_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://your-app.com', // optional
            'X-Title': 'UBCBot' // optional
        },
        body: JSON.stringify({
            model: process.env.AI_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessageWithContext }
            ],
            max_tokens: 0,
            temperature: 0.9
        })
    });

    if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();

    const content =
        data?.choices?.[0]?.message?.content ||
        data?.choices?.[0]?.text ||
        data?.result?.output?.[0]?.content?.[0]?.text;

    if (!content) {
        console.error('OpenRouter unexpected response body:', JSON.stringify(data, null, 2));
        throw new Error('Invalid response from AI API');
    }

    const text = content.trim();
    return `@${username}, ${text}`;

}

function getRandomCompliment() {
    const i = Math.floor(Math.random() * compliments.length);
    return compliments[i];
}

const V_REWARDS = [
    '9c5f80ee-2074-4b25-8c66-89178a13ecef', // Выгнать на улицу (V)
    '8909121d-c2c3-427f-95f6-feaf2f2fa92b', // Сделать клоуна (V)
    'a64afe27-756b-48c4-bdbd-17075dbb6828', // Обвинить в фембой-стве (V)
    'e8ebb4b5-8d7a-4e20-aff3-923213d6e616'  // Гладить (V)
];

const SR_REWARDS = [
    '5c8adc76-dc97-4b11-a355-ae24cf79912c', // 1
    '6e53c204-ac7d-46bb-89d6-ce323531a63c', // 2
    'b6adc235-77fd-456a-b6bd-a246562d9a9e'  // 3
];

async function handleMode(REWARDS, arg) {
    // если VR включен → выключаем V-награды
    for (const rewardId of REWARDS) {
        await toggleReward({
            broadcasterId: process.env.BROADCASTER_ID,
            rewardId: rewardId,
            enabled: arg,
            accessToken: process.env.TWITCH_TOKEN_MY,
            clientId: process.env.CLIENT_ID_MY
        });

        console.log(`Reward ${rewardId} -> ${arg}`);
    }
}

// =========================
// Экспорт
// =========================
module.exports = {
    loadCommands,
    getCommands,
    hasCommand,
    getCommandResponse
};