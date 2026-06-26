const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ensure sessions directory exists
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Global Session State
let sessionState = {
    sock: null,
    status: 'INITIALIZING',
    qr: null,
    userNumber: null
};

// Initialize WhatsApp
async function startWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, 'auth_info'));
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            markOnlineOnConnect: false,
        });

        sessionState.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionState.status = 'DISCONNECTED';
                try {
                    sessionState.qr = await QRCode.toDataURL(qr);
                    console.log('📱 New QR Code Generated');
                } catch (err) {
                    console.error('QR Generation Error:', err);
                }
            }

            if (connection === 'open') {
                sessionState.status = 'CONNECTED';
                sessionState.qr = null;
                sessionState.userNumber = sock.user?.id?.split(':')[0] || null;
                console.log(`✅ Connected Successfully as +${sessionState.userNumber}`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                sessionState.status = 'DISCONNECTED';
                sessionState.userNumber = null;

                if (shouldReconnect) {
                    console.log(`🔄 Connection closed. Reconnecting in 3 seconds...`);
                    setTimeout(startWhatsApp, 3000);
                } else {
                    console.log("🚪 Logged out. Clearing session...");
                    fs.rmSync(path.join(sessionsDir, 'auth_info'), { recursive: true, force: true });
                    startWhatsApp();
                }
            }
        });

    } catch (err) {
        console.error("❌ Failed to start WhatsApp:", err);
        setTimeout(startWhatsApp, 5000);
    }
}

// ====================== ROUTES ======================

// Serve Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Status API
app.get('/api/status', (req, res) => {
    res.json({
        status: sessionState.status,
        qr: sessionState.qr,
        number: sessionState.userNumber
    });
});

// Get All Groups
app.get('/api/groups', async (req, res) => {
    if (sessionState.status !== 'CONNECTED' || !sessionState.sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
    }

    try {
        const groups = await sessionState.sock.groupFetchAllParticipating();
        const groupList = [];

        for (const g of Object.values(groups)) {
            try {
                const meta = await sessionState.sock.groupMetadata(g.id);
                groupList.push({
                    id: g.id,
                    subject: g.subject || 'Unnamed Group',
                    size: meta.participants?.length || 0
                });
            } catch {
                groupList.push({
                    id: g.id,
                    subject: g.subject || 'Unnamed Group',
                    size: g.participants?.length || 0
                });
            }
        }

        const filtered = groupList
            .filter(g => g.size > 1)
            .sort((a, b) => b.size - a.size);

        res.json(filtered);
    } catch (err) {
        console.error("Error fetching groups:", err);
        res.status(500).json({ error: err.message });
    }
});

// Download CSV
app.get('/api/groups/:id/csv', async (req, res) => {
    if (sessionState.status !== 'CONNECTED' || !sessionState.sock) {
        return res.status(400).send('WhatsApp is not connected yet.');
    }

    try {
        const groupId = req.params.id;
        const meta = await sessionState.sock.groupMetadata(groupId);

        let csvContent = 'Phone Number,Is Admin\n';

        for (let participant of meta.participants) {
            if (!participant.id.includes('@s.whatsapp.net')) continue;
            const number = participant.id.split('@')[0];
            const isAdmin = (participant.admin === 'admin' || participant.admin === 'superadmin') ? 'Yes' : 'No';
            csvContent += `'+${number},${isAdmin}\n`;
        }

        const safeName = (meta.subject || 'group').replace(/[^a-z0-9]/gi, '_').toLowerCase();
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_contacts.csv"`);
        res.send(csvContent);
    } catch (err) {
        console.error("CSV Error:", err);
        res.status(500).send("Error generating CSV: " + err.message);
    }
});

// Get Members JSON
app.get('/api/groups/:id/members', async (req, res) => {
    if (sessionState.status !== 'CONNECTED' || !sessionState.sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
    }

    try {
        const groupId = req.params.id;
        const meta = await sessionState.sock.groupMetadata(groupId);

        const members = meta.participants
            .filter(p => p.id.includes('@s.whatsapp.net'))
            .map(p => ({
                id: '+' + p.id.split('@')[0],
                isAdmin: (p.admin === 'admin' || p.admin === 'superadmin')
            }));

        res.json(members);
    } catch (err) {
        console.error("Members API Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`==========================================`);
    console.log(` 🚀 WhatsApp Group Extractor Running!`);
    console.log(` 🌐 Open: http://localhost:${port}`);
    console.log(`==========================================`);
});

// Boot WhatsApp
startWhatsApp();
