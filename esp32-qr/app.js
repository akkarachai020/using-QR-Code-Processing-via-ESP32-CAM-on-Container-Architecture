
process.env.TZ = 'Asia/Bangkok';

const express = require('express');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const jpeg = require('jpeg-js');
const jsQR = require('jsqr');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const latestImagePath = path.join(__dirname, 'latest.jpg');

app.use(express.json({ limit: '1mb' }));
app.use('/upload', express.raw({
    type: 'image/jpeg',
    limit: '10mb'
}));

// ==================== DATABASE ====================

const dbConfig = {
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'rootpassword',
    database: process.env.DB_NAME || 'attendance_db'
};

let db = null;

async function initDB() {
    let retries = 10;

    while (retries > 0) {
        try {
            db = await mysql.createConnection({
                ...dbConfig,
                timezone: '+07:00'
            });

            await db.query("SET time_zone = '+07:00'");

            console.log('✅ Node.js เชื่อมต่อ MySQL สำเร็จ');
            return;
        } catch (err) {
            console.error(
                `⏳ กำลังรอ MySQL (${retries}):`,
                err.message
            );

            if (db) {
                try {
                    await db.end();
                } catch (_) {}
                db = null;
            }

            retries--;
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    console.error('❌ เชื่อมต่อ MySQL ไม่สำเร็จ');
}

// ==================== TIME ====================

function getThaiTime() {
    return new Date().toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'short',
        timeStyle: 'medium'
    });
}

// ใช้ส่งเวลาให้ ESP32-CAM ตั้งค่า DS3231
function getThaiDateParts() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date());

    const result = {};

    for (const part of parts) {
        if (part.type !== 'literal') {
            result[part.type] = Number(part.value);
        }
    }

    return result;
}

// ==================== TELEGRAM ====================

async function sendTelegram(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.error(
            '❌ กรุณาตั้ง TELEGRAM_BOT_TOKEN และ TELEGRAM_CHAT_ID ใน .env'
        );
        return false;
    }

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${token}/sendMessage`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: message
                }),
                signal: AbortSignal.timeout(10000)
            }
        );

        const result = await response.json();

        if (!response.ok || result.ok !== true) {
            console.error(
                '❌ Telegram ส่งไม่สำเร็จ:',
                result.description || response.statusText
            );
            return false;
        }

        console.log('✅ ส่งข้อความ Telegram สำเร็จ');
        return true;
    } catch (err) {
        console.error('❌ ติดต่อ Telegram ไม่สำเร็จ:', err.message);
        return false;
    }
}

// ==================== LOOKUP STUDENT ====================

async function getStudentName(studentId) {
    const fallback = {
        first_name: 'ไม่พบข้อมูล',
        last_name: 'ในระบบ'
    };

    const [rows] = await db.execute(
        `SELECT first_name, last_name
         FROM students
         WHERE student_id = ?
         LIMIT 1`,
        [studentId]
    );

    if (rows.length === 0) {
        return fallback;
    }

    return {
        first_name: rows[0].first_name || fallback.first_name,
        last_name: rows[0].last_name || fallback.last_name
    };
}

// ==================== WEB PAGES ====================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/attendance', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'attendance.html'));
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        database: db ? 'connected' : 'disconnected',
        telegram_configured: Boolean(
            process.env.TELEGRAM_BOT_TOKEN &&
            process.env.TELEGRAM_CHAT_ID
        )
    });
});

// ==================== TEST TELEGRAM ====================

app.get('/api/test-telegram', async (req, res) => {
    const testKey = process.env.TELEGRAM_TEST_KEY;

    if (!testKey) {
        return res.status(503).json({
            status: 'error',
            message: 'กรุณาตั้ง TELEGRAM_TEST_KEY ใน .env ก่อน'
        });
    }

    if (req.query.key !== testKey) {
        return res.status(401).json({
            status: 'error',
            message: 'Unauthorized'
        });
    }

    const sent = await sendTelegram(
        `🧪 ทดสอบระบบแจ้งเตือน\nเวลา: ${getThaiTime()}`
    );

    if (!sent) {
        return res.status(502).json({
            status: 'error',
            message: 'ส่ง Telegram ไม่สำเร็จ ตรวจสอบ Docker logs'
        });
    }

    return res.json({
        status: 'success',
        success: true,
        message: 'ส่งข้อความทดสอบ Telegram สำเร็จ'
    });
});

// ==================== API TIME ====================

app.get('/time', (req, res) => {
    const parts = getThaiDateParts();

    const timestamp = Math.floor(Date.now() / 1000);

    res.json({
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
        timestamp
    });
});

// ==================== UPLOAD IMAGE / SCAN QR ====================

app.post('/upload', async (req, res) => {
    const imageBuffer = req.body;

    if (
        !imageBuffer ||
        !Buffer.isBuffer(imageBuffer) ||
        imageBuffer.length === 0
    ) {
        return res.status(400).json({
            status: 'error',
            message: 'No image data',
            qr_found: false
        });
    }

    const clientTimestamp = req.headers['x-timestamp'];

    try {
        const rawImageData = jpeg.decode(imageBuffer, {
            useTolerantDecoding: true
        });

        const code = jsQR(
            Uint8ClampedArray.from(rawImageData.data),
            rawImageData.width,
            rawImageData.height
        );

        if (!code || !code.data) {
            console.log('ℹ️ ไม่พบ QR Code ในภาพ');

            return res.json({
                status: 'success',
                qr_found: false,
                student_id: null,
                first_name: null,
                last_name: null,
                saved_to_db: false,
                data: []
            });
        }

        const studentId = String(code.data).trim();

        if (!studentId) {
            return res.json({
                status: 'success',
                qr_found: false,
                saved_to_db: false,
                data: []
            });
        }

        console.log(`🎯 ตรวจพบ QR Code: ${studentId}`);

        // บันทึกภาพล่าสุด
        try {
            fs.writeFileSync(latestImagePath, imageBuffer);
        } catch (fileErr) {
            console.error(
                '❌ บันทึกภาพล่าสุดไม่สำเร็จ:',
                fileErr.message
            );
        }

        if (!db) {
            return res.status(503).json({
                status: 'error',
                message: 'Database disconnected',
                qr_found: true,
                student_id: studentId,
                saved_to_db: false
            });
        }

        // อ่านเวลาจาก ESP32 หากถูกต้อง
        let scanTime = null;

        if (clientTimestamp) {
            const timestampText = String(clientTimestamp).trim();
            const parsed = new Date(
                timestampText.replace(' ', 'T') + (
                    /(?:Z|[+-]\d{2}:\d{2})$/.test(timestampText)
                        ? ''
                        : '+07:00'
                )
            );

            if (!Number.isNaN(parsed.getTime())) {
                scanTime = parsed;
            }
        }

        // บันทึก MySQL ก่อนส่ง Telegram
        try {
            if (scanTime) {
                await db.execute(
                    `INSERT INTO attendance_logs (student_id, scan_time)
                     VALUES (?, ?)`,
                    [studentId, scanTime]
                );
            } else {
                await db.execute(
                    `INSERT INTO attendance_logs (student_id, scan_time)
                     VALUES (?, NOW())`,
                    [studentId]
                );
            }
        } catch (dbErr) {
            console.error(
                '❌ บันทึก MySQL ไม่สำเร็จ:',
                dbErr.message
            );

            return res.status(500).json({
                status: 'error',
                message: 'Database insert failed',
                qr_found: true,
                student_id: studentId,
                saved_to_db: false
            });
        }

        // ค้นหาชื่อนักศึกษา
        let student = {
            first_name: 'ไม่พบข้อมูล',
            last_name: 'ในระบบ'
        };

        try {
            student = await getStudentName(studentId);
        } catch (lookupErr) {
            console.error(
                '❌ ค้นหาชื่อนักศึกษาไม่สำเร็จ:',
                lookupErr.message
            );
        }

        // แจ้ง Telegram เพียงฝั่ง Node.js
        const telegramMessage =
            `✅ บันทึกเวลาเข้าร่วมกิจกรรมสำเร็จ\n\n` +
            `🆔 รหัสนักศึกษา: ${studentId}\n` +
            `👤 ชื่อ-นามสกุล: ${student.first_name} ${student.last_name}\n` +
            `📅 เวลา: ${getThaiTime()}`;

        await sendTelegram(telegramMessage);

        return res.json({
            status: 'success',
            qr_found: true,
            student_id: studentId,
            first_name: student.first_name,
            last_name: student.last_name,
            saved_to_db: true,
            data: [studentId]
        });
    } catch (err) {
        console.error('❌ ประมวลผลภาพหรือ QR ไม่สำเร็จ:', err.message);

        return res.status(400).json({
            status: 'error',
            message: 'Unable to decode JPEG image',
            qr_found: false,
            saved_to_db: false
        });
    }
});

// ==================== SYNC OFFLINE DATA ====================

app.post('/api/sync-offline', async (req, res) => {
    const { student_id, scan_time } = req.body || {};

    if (!student_id || !scan_time) {
        return res.status(400).json({
            status: 'error',
            success: false,
            message: 'Missing parameters'
        });
    }

    if (!db) {
        return res.status(503).json({
            status: 'error',
            success: false,
            message: 'Database disconnected'
        });
    }

    const id = String(student_id).trim();

    try {
        // บันทึกข้อมูลย้อนหลัง
        await db.execute(
            `INSERT INTO attendance_logs (student_id, scan_time)
             VALUES (?, ?)`,
            [id, scan_time]
        );

        let student = {
            first_name: 'ไม่พบข้อมูล',
            last_name: 'ในระบบ'
        };

        try {
            student = await getStudentName(id);
        } catch (lookupErr) {
            console.error(
                '❌ ค้นหาชื่อข้อมูล Offline ไม่สำเร็จ:',
                lookupErr.message
            );
        }

        console.log(
            `🔄 ซิงค์ Offline สำเร็จ: ${id} (${scan_time})`
        );

        // ส่ง Telegram หลังบันทึก MySQL สำเร็จ
        const telegramMessage =
            `🔄 ซิงค์เวลาเข้าร่วมกิจกรรมย้อนหลัง\n\n` +
            `🆔 รหัสนักศึกษา: ${id}\n` +
            `👤 ชื่อ-นามสกุล: ${student.first_name} ${student.last_name}\n` +
            `📅 เวลาที่บันทึก: ${scan_time}`;

        await sendTelegram(telegramMessage);

        return res.json({
            status: 'success',
            success: true,
            student_id: id
        });
    } catch (err) {
        console.error(
            '❌ ซิงค์ Offline ไม่สำเร็จ:',
            err.message
        );

        return res.status(500).json({
            status: 'error',
            success: false,
            message: 'Failed to sync offline data'
        });
    }
});

// ==================== LATEST IMAGE ====================

app.get('/latest.jpg', (req, res) => {
    if (fs.existsSync(latestImagePath)) {
        return res.sendFile(latestImagePath);
    }

    return res.status(404).send('No image');
});

// ==================== RECENT ATTENDANCE ====================

app.get('/api/recent', async (req, res) => {
    if (!db) {
        return res.status(503).json({
            status: 'error',
            message: 'Database disconnected'
        });
    }

    try {
        const query = `
            SELECT
                a.student_id,
                COALESCE(s.first_name, 'ไม่พบข้อมูล') AS first_name,
                COALESCE(s.last_name, 'ในระบบ') AS last_name,
                DATE_FORMAT(a.scan_time, '%H:%i:%s') AS scan_time
            FROM attendance_logs a
            LEFT JOIN students s
                ON a.student_id = s.student_id
            ORDER BY a.id DESC
            LIMIT 5
        `;

        const [rows] = await db.query(query);
        return res.json(rows);
    } catch (err) {
        console.error('❌ Error /api/recent:', err.message);
        return res.status(500).json([]);
    }
});

// ==================== ALL ATTENDANCE ====================

app.get('/api/all-attendance', async (req, res) => {
    if (!db) {
        return res.status(503).json({
            status: 'error',
            message: 'Database disconnected'
        });
    }

    try {
        const query = `
            SELECT
                a.student_id,
                COALESCE(s.first_name, 'ไม่พบข้อมูล') AS first_name,
                COALESCE(s.last_name, 'ในระบบ') AS last_name,
                DATE_FORMAT(a.scan_time, '%d/%m/%Y %H:%i:%s') AS scan_time
            FROM attendance_logs a
            LEFT JOIN students s
                ON a.student_id = s.student_id
            ORDER BY a.id DESC
        `;

        const [rows] = await db.query(query);
        return res.json(rows);
    } catch (err) {
        console.error('❌ Error /api/all-attendance:', err.message);
        return res.status(500).json([]);
    }
});

// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Node.js Server running on port ${PORT}`);
    initDB();
});
