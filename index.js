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
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

// Global Session State
let sessionState = {
    sock: null,
    status: 'INITIALIZING',
    qr: null,
    userNumber: null
};

// Initialize WhatsApp Engine
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, 'auth_info'));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, // Also prints in terminal for convenience 
        logger: pino({ level: 'silent' }), // Suppress heavy logs
    });

    sessionState.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.status = 'DISCONNECTED';
            try {
                sessionState.qr = await QRCode.toDataURL(qr);
                console.log('New QR Code generated. Awaiting scan...');
            } catch (err) {
                console.error("Failed to generate QR base64:", err);
            }
        }

        if (connection === 'open') {
            sessionState.status = 'CONNECTED';
            sessionState.qr = null;
            sessionState.userNumber = sock.user.id.split(':')[0];
            console.log(`✅ Successfully Logged In! Connected as +${sessionState.userNumber}`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            sessionState.status = 'DISCONNECTED';
            sessionState.userNumber = null;

            if (shouldReconnect) {
                console.log(`Connection dropped (${statusCode}). Reconnecting...`);
                setTimeout(startWhatsApp, 3000);
            } else {
                console.log("Session forcefully logged out. Clearing local files.");
                fs.rmSync(path.join(sessionsDir, 'auth_info'), { recursive: true, force: true });
                startWhatsApp(); // Restart to get new QR
            }
        }
    });
}

// Boot up Baileys on script start
startWhatsApp();

// ====================== ROUTES ======================

// 1. Serve HTML Dashboard directly from the file
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Group Extractor</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50 p-8 font-sans text-gray-800">
        <div class="max-w-4xl mx-auto bg-white p-6 rounded-xl shadow-lg border border-gray-100">
            <h1 class="text-3xl font-extrabold mb-6 text-center text-green-600">WhatsApp Group Extractor</h1>
            
            <!-- Auth & Status Section -->
            <div id="auth-section" class="text-center flex flex-col items-center">
                <h2 id="status-text" class="text-lg font-semibold text-gray-700 mb-4 bg-gray-100 px-4 py-2 rounded-full inline-block">Checking connection status...</h2>
                <div id="qr-container" class="hidden">
                    <p class="text-sm text-gray-500 mb-2">Scan this QR code with your WhatsApp to login</p>
                    <img id="qr-image" src="" alt="QR Code" class="mx-auto w-72 h-72 border-4 border-gray-100 rounded-lg shadow-sm">
                </div>
            </div>

            <!-- Groups Section -->
            <div id="groups-section" class="hidden mt-8">
                <div class="flex justify-between items-center mb-6 border-b pb-4">
                    <h2 class="text-2xl font-bold text-gray-800">Your Connected Groups</h2>
                    <span id="group-count" class="bg-blue-100 text-blue-800 text-sm font-semibold px-3 py-1 rounded-full">Loading...</span>
                </div>
                
                <div id="loading-groups" class="text-center text-gray-500 py-8">Fetching group data from WhatsApp...</div>
                
                <!-- Group List Grid -->
                <div id="groups-list" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
            </div>
        </div>

        <script>
            let isConnected = false;

            // Polling loop to check WhatsApp connection status
            async function checkStatus() {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();
                    
                    const statusText = document.getElementById('status-text');
                    const qrContainer = document.getElementById('qr-container');
                    const qrImage = document.getElementById('qr-image');
                    const authSection = document.getElementById('auth-section');
                    const groupsSection = document.getElementById('groups-section');

                    if (data.status === 'DISCONNECTED' && data.qr) {
                        statusText.innerText = 'Status: Waiting for QR Scan';
                        statusText.className = 'text-lg font-semibold text-yellow-600 mb-4 bg-yellow-50 px-4 py-2 rounded-full inline-block';
                        qrImage.src = data.qr;
                        qrContainer.classList.remove('hidden');
                        groupsSection.classList.add('hidden');
                        setTimeout(checkStatus, 3000); // check again in 3s
                    } else if (data.status === 'CONNECTED') {
                        if (!isConnected) {
                            isConnected = true;
                            qrContainer.classList.add('hidden');
                            authSection.innerHTML = '<div class="p-4 bg-green-50 border border-green-200 text-green-700 rounded-lg font-semibold flex items-center justify-center gap-2"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> Successfully Connected!</div>';
                            groupsSection.classList.remove('hidden');
                            loadGroups(); // Fetch groups once connected
                        }
                    } else {
                        statusText.innerText = 'Status: Initializing / Connecting...';
                        setTimeout(checkStatus, 3000);
                    }
                } catch (e) {
                    setTimeout(checkStatus, 3000);
                }
            }

            // Fetch and render groups
            async function loadGroups() {
                try {
                    const res = await fetch('/api/groups');
                    const groups = await res.json();
                    
                    document.getElementById('loading-groups').classList.add('hidden');
                    document.getElementById('group-count').innerText = groups.length + ' Groups found';
                    
                    const list = document.getElementById('groups-list');
                    list.innerHTML = '';

                    groups.forEach(group => {
                        const item = document.createElement('div');
                        item.className = 'flex flex-col justify-between p-5 bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md transition-shadow';
                        item.innerHTML = \`
                            <div class="mb-4">
                                <h3 class="font-bold text-lg text-gray-800 line-clamp-1" title="\${group.subject}">\${group.subject || 'Unknown Group'}</h3>
                                <div class="text-sm text-gray-500 mt-1 flex items-center gap-1">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
                                    \${group.size} Participants
                                </div>
                            </div>
                            <a href="/api/groups/\${group.id}/csv" class="w-full text-center px-4 py-2 bg-green-600 text-white font-medium rounded-lg shadow-sm hover:bg-green-700 transition-colors flex items-center justify-center gap-2" download>
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                Download CSV
                            </a>
                        \`;
                        list.appendChild(item);
                    });
                } catch (e) {
                    document.getElementById('loading-groups').innerText = 'Failed to load groups. See console.';
                    console.error('Error fetching groups:', e);
                }
            }

            // Start polling on load
            checkStatus();
        </script>
    </body>
    </html>
    `);
});

// 2. Status API (Used by frontend to get QR / Connection status)
app.get('/api/status', (req, res) => {
    res.json({
        status: sessionState.status,
        qr: sessionState.qr,
        number: sessionState.userNumber
    });
});

// 3. Get all groups
app.get('/api/groups', async (req, res) => {
    if (sessionState.status !== 'CONNECTED' || !sessionState.sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
    }

    try {
        // Fetch all participating groups
        const groups = await sessionState.sock.groupFetchAllParticipating();
        
        // Format them into a clean array
        const groupList = Object.values(groups).map(g => ({
            id: g.id,
            subject: g.subject,
            size: g.participants ? g.participants.length : 0
        })).sort((a, b) => b.size - a.size); // Sort by largest group first

        res.json(groupList);
    } catch (err) {
        console.error("Error fetching groups:", err);
        res.status(500).json({ error: err.message });
    }
});

// 4. Generate & Download CSV for a specific group
app.get('/api/groups/:id/csv', async (req, res) => {
    if (sessionState.status !== 'CONNECTED' || !sessionState.sock) {
        return res.status(400).send('WhatsApp is not connected yet.');
    }

    try {
        const groupId = req.params.id;
        
        // Fetch fresh metadata for this specific group
        const groupMeta = await sessionState.sock.groupMetadata(groupId);
        
        // Construct CSV Content
        let csvContent = 'Phone Number,Is Admin\n';
        
        for (let participant of groupMeta.participants) {
            // Extract pure phone number from JID (e.g., "919999999999@s.whatsapp.net" -> "919999999999")
            const number = participant.id.split('@')[0];
            const isAdmin = (participant.admin === 'admin' || participant.admin === 'superadmin') ? 'Yes' : 'No';
            csvContent += `${number},${isAdmin}\n`;
        }

        // Clean group name for a safe filename
        const safeName = groupMeta.subject.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        // Send file headers for browser download
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_contacts.csv"`);
        
        // Transmit generated CSV
        res.send(csvContent);
    } catch (err) {
        console.error("Error generating CSV:", err);
        res.status(500).send("Error generating CSV: " + err.message);
    }
});

// Start Server
app.listen(port, () => {
    console.log(`==========================================`);
    console.log(` 🚀 WhatsApp Group Extractor is Running!`);
    console.log(` 🌐 Open Dashboard: http://localhost:${port}`);
    console.log(`==========================================`);
});
