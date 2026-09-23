const path = require('path');
const Database = require('better-sqlite3');

// Всегда корневой bot.db, независимо от того, из какой папки запущен бот
const db = new Database(path.join(__dirname, '..', '..', 'bot.db'));

// Создаём таблицу
db.prepare(`
    CREATE TABLE IF NOT EXISTS points (
        username TEXT PRIMARY KEY,
        luckPoints INTEGER DEFAULT 0
    )
`).run();

function getLuckPoints(username) {
    const row = db.prepare(`SELECT luckPoints FROM points WHERE username = ?`).get(username);
    return row ? row.luckPoints : 0;
}

function addLuckPoint(luckPoints, username) {
    db.prepare(`
        INSERT INTO points (username, luckPoints)
        VALUES (?, ?)
        ON CONFLICT(username) DO UPDATE SET luckPoints = luckPoints + ?
    `).run(username, luckPoints, luckPoints);
}

function removeLuckPoint(luckPoints, username) {
    db.prepare(`
        UPDATE points SET luckPoints = MAX(luckPoints - ?, 0)
        WHERE username = ?
    `).run(luckPoints, username);
}

// =========================
// Экспорт
// =========================
module.exports = {
    getLuckPoints,
    addLuckPoint,
    removeLuckPoint
};