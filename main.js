const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const DB_PATH = path.join(app.getPath('userData'), 'entamelog.db');
let db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Database opening error: ', err.message);
    } else {
        console.log('Database connected.');
        db.run(`
            CREATE TABLE IF NOT EXISTS ViewingHistory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                media_title TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                rating INTEGER,
                notes TEXT,
                recorded_at TEXT NOT NULL,
                tags TEXT
            )
        `);
    }
});

// --- IPCハンドラ ---
function setupIpcHandlers() {
    ipcMain.handle('record-history', (event, data) => {
        return new Promise((resolve) => {
            recordViewingHistory(data, (err, result) => {
                if (err) resolve({ success: false, message: err.message });
                else resolve(result);
            });
        });
    });

    ipcMain.handle('get-history', () => {
        return new Promise((resolve) => {
            getAllViewingHistory((err, result) => {
                if (err) resolve(err.message);
                else resolve(result);
            });
        });
    });

    ipcMain.handle('search-media', async (event, mediaTitle) => {
        return await searchMediaWithGemini(mediaTitle);
    });

    ipcMain.handle('get-ai-recommendations-media', async () => {
        return await getAiRecommendationsMedia();
    });

    ipcMain.on('reset-history', () => {
        db.close((err) => {
            if (err) console.error('DB close error on reset:', err.message);
            try {
                fs.unlinkSync(DB_PATH);
                app.relaunch();
                app.quit();
            } catch (fsErr) {
                console.error('File deletion error on reset:', fsErr);
            }
        });
    });
}

// --- ビジネスロジック (コールバック版) ---

function recordViewingHistory(data, callback) {
    const { mediaTitle, startDate, endDate, rating, notes, tags } = data;
    if (!mediaTitle || !startDate || !endDate) {
        return callback(null, { success: false, message: 'エラー: 作品名、開始日、終了日は必須項目です。' });
    }
    const recordedAt = new Date().toISOString();
    const sql = 'INSERT INTO ViewingHistory (media_title, start_date, end_date, rating, notes, recorded_at, tags) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const params = [mediaTitle, startDate, endDate, rating, notes, recordedAt, tags];
    
    db.run(sql, params, function(err) {
        if (err) {
            console.error('Error recording history:', err);
            return callback(err);
        }
        callback(null, { success: true, message: `視聴履歴を記録しました: '${mediaTitle}'` });
    });
}

function getAllViewingHistory(callback) {
    db.all('SELECT * FROM ViewingHistory ORDER BY recorded_at DESC', (err, rows) => {
        if (err) {
            console.error('Error getting all history:', err);
            return callback(err);
        }
        if (rows.length === 0) return callback(null, "まだ視聴履歴がありません。");

        let displayText = "--- 視聴履歴一覧 ---\n";
        rows.forEach(row => {
            const { media_title, start_date, end_date, rating, notes, tags } = row;
            const rating_str = rating ? ` (評価:${rating})` : '';
            const notes_str = (notes && notes.trim()) ? ` [メモ: ${notes}]` : '';
            const tags_str = (tags && tags.trim()) ? ` [タグ: ${tags}]` : '';
            displayText += `・${start_date} ~ ${end_date}: ${media_title}${rating_str}${notes_str}${tags_str}\n`;
        });
        callback(null, displayText);
    });
}

async function searchMediaWithGemini(mediaTitle) {
    if (!mediaTitle) return "作品名を入力してください。";
    try {
        const prompt = `以下の##作品名##について、指定された##JSON形式##で情報をまとめてください。\n\n##作品名##\n${mediaTitle}\n\n##JSON形式##\n{\n  "summary": "作品の概要を200文字程度で記述してください。",\n  "genre": "作品のジャンルを複数記述してください。例: ['ファンタジー', '冒険']",\n  "streaming_sites": "日本国内で視聴可能な主要な動画配信サイトをリストで記述してください。例: ['Netflix', 'Amazon Prime Video', 'Hulu']"\n}\n\n情報が見つからない場合は、各項目に「情報が見つかりませんでした。」と記述してください。`;
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text().replace(/^```json\s*|```$/g, '').trim();
        let formattedResult;
        try {
            const info = JSON.parse(text);
            formattedResult = `作品: '${mediaTitle}' の情報\n`;
            formattedResult += "----------------------------------------\n";
            formattedResult += `【概要】\n${info.summary || '情報なし'}\n\n`;
            formattedResult += `【ジャンル】\n${info.genre ? info.genre.join(', ') : '情報なし'}\n\n`;
            formattedResult += `【主な配信サイト】\n${info.streaming_sites ? info.streaming_sites.map(site => `- ${site}`).join('\n') : '情報なし'}\n`;
            formattedResult += "----------------------------------------\n";
            formattedResult += "\n(この情報はGeminiによって生成されました)";
        } catch (parseError) {
            console.error('Error parsing Gemini response:', parseError, 'Raw response:', text);
            formattedResult = `Geminiからの応答を解析できませんでした。\n\n---\n${text}`;
        }
        return formattedResult;
    } catch (error) {
        console.error(`Gemini APIとの通信中にエラーが発生しました: ${error}`);
        return `作品: '${mediaTitle}' の情報取得中にエラーが発生しました。\nAPIキーの設定やネットワーク接続を確認してください。\n(エラー: ${error.message})`;
    }
}

async function getAiRecommendationsMedia() {
    return `--- AIおすすめ作品 ---\n現在、AIおすすめ機能は開発中です。\n今後は視聴履歴を基にGeminiが新しい作品をおすすめする機能が追加されます。`;
}


// --- Electronアプリの基本設定 ---
function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true, 
      contextIsolation: false
    }
  });
  //mainWindow.webContents.openDevTools();
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});