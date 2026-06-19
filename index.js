/**
 * WhatsApp Group Contact Extractor (Instant & Reliable LocalAuth Version)
 * * Is version mein Google Chrome lock hone ka koi jhanjhat nahi hai!
 * * Yeh ek isolated browser use karta hai aur aapka session '.wwebjs_auth' folder mein save rakhta hai.
 * * Aapko sirf ek baar QR Code scan karna hoga, uske baad hamesha auto-login ho jayega.
 * * * Kaise chalayein:
 * 1. Terminal mein dependencies install karein:
 * npm install express socket.io whatsapp-web.js qrcode
 * 2. Run karein:
 * node index.js
 * 3. Browser mein http://localhost:3000 kholein aur instant maza lein!
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// WhatsApp Client setup (LocalAuth use kar rahe hain taaki session safe aur persistent rahe)
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth' // Session data isi folder me save rahega
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

let currentStatus = 'Initializing...';
let liveLogs = [];
let latestQrCode = null;
let activeGroups = [];

// Status aur Logs ko manage karne ka helper function
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const formattedLog = { id: Date.now() + Math.random(), timestamp, message, type };
    liveLogs.push(formattedLog);
    if (liveLogs.length > 50) liveLogs.shift(); // Max 50 logs save rakhein
    io.emit('log', formattedLog);
    console.log(`[${timestamp}] ${message}`);
}

function updateStatus(newStatus) {
    currentStatus = newStatus;
    io.emit('status', currentStatus);
}

// WhatsApp Client Ke Events
client.on('qr', (qr) => {
    updateStatus('Scan QR Code');
    latestQrCode = qr;
    addLog('Naya QR Code taiyar hai! Kripya screen par scan karein.', 'warning');
    
    QRCode.toDataURL(qr, (err, url) => {
        if (!err) {
            io.emit('qr', url);
        }
    });
});

client.on('loading_screen', (percent, message) => {
    updateStatus(`Sync ho raha hai...`);
    addLog(`WhatsApp loading screen: ${percent}% - ${message || 'Data sync ho raha hai'}`, 'info');
});

client.on('authenticated', () => {
    updateStatus('Authenticated');
    latestQrCode = null;
    addLog('Authentication safal rhi! Session save kar liya gaya hai.', 'success');
});

client.on('auth_failure', (msg) => {
    updateStatus('Authentication Failed');
    addLog(`Login fail ho gaya: ${msg}. Kripya firse koshish karein.`, 'error');
});

client.on('ready', async () => {
    updateStatus('Connected Hain');
    latestQrCode = null;
    addLog('WhatsApp Client completely Ready ho chuka hai!', 'success');

    try {
        addLog('Aapke chat list se WhatsApp Groups dhoondhe ja rahe hain...', 'info');
        const chats = await client.getChats();
        activeGroups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name || 'Unnamed Group',
                unreadCount: chat.unreadCount
            }));
        
        addLog(`Safaltapoorvak ${activeGroups.length} groups mil gaye hain!`, 'success');
        io.emit('groups', activeGroups);
    } catch (err) {
        addLog(`Groups fetch karne mein dikkat aayi: ${err.message}`, 'error');
        io.emit('error', 'Groups load nahi ho paye. Kripya page refresh karein.');
    }
});

client.on('disconnected', (reason) => {
    updateStatus('Disconnected');
    latestQrCode = null;
    activeGroups = [];
    addLog(`WhatsApp disconnect ho gaya. Reason: ${reason}`, 'error');
});

// Real-time WebSocket connection handling
io.on('connection', (socket) => {
    // Naye user ko current state aur purane logs send karein
    socket.emit('status', currentStatus);
    socket.emit('logs_history', liveLogs);
    
    if (latestQrCode && currentStatus === 'Scan QR Code') {
        QRCode.toDataURL(latestQrCode, (err, url) => {
            if (!err) socket.emit('qr', url);
        });
    }
    
    if (activeGroups.length > 0) {
        socket.emit('groups', activeGroups);
    }
});

// CSV Extraction API Endpoint
app.get('/api/export/:groupId', async (req, res) => {
    try {
        if (currentStatus !== 'Connected Hain') {
            return res.status(400).send('WhatsApp abhi connected nahi hai.');
        }

        const groupId = req.params.groupId;
        addLog(`Group ID ke contacts extract ho rahe hain: ${groupId}`, 'info');

        const chat = await client.getChatById(groupId);
        if (!chat.isGroup) {
            return res.status(400).send('Selected chat group nahi hai.');
        }

        let csvRows = ['Phone Number,Formatted ID,Display Name,Role\n'];

        for (const participant of chat.participants) {
            const contact = await client.getContactById(participant.id._serialized);
            const rawNumber = participant.id.user;
            const serializedId = participant.id._serialized;
            const displayName = contact.pushname || contact.name || 'Unknown Contact';
            const isAdmin = participant.isAdmin || participant.isSuperAdmin ? 'Admin' : 'Member';

            // Special characters and commas escape karne ke liye double quotes lagayein
            const escapedName = `"${displayName.replace(/"/g, '""')}"`;
            csvRows.push(`${rawNumber},${serializedId},${escapedName},${isAdmin}\n`);
        }

        const sanitizedFileName = (chat.name || 'group_contacts')
            .replace(/[^a-z0-9]/gi, '_')
            .toLowerCase();

        addLog(`Group "${chat.name}" ke ${chat.participants.length} contacts successfully export ho gaye!`, 'success');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFileName}_contacts.csv"`);
        res.send(csvRows.join(''));

    } catch (err) {
        addLog(`Export fail ho gaya: ${err.message}`, 'error');
        res.status(500).send('Error generating CSV: ' + err.message);
    }
});

// UI Delivery
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en" class="h-full bg-slate-950">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Instant WA Contact Extractor</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="/socket.io/socket.io.js"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="h-full flex flex-col justify-between text-slate-100 font-sans">
        
        <!-- Header -->
        <header class="border-b border-slate-800 bg-slate-900/40 backdrop-blur sticky top-0 z-50">
            <div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
                <div class="flex items-center space-x-3">
                    <div class="bg-emerald-500 p-2 rounded-xl text-slate-950 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                        <i class="fa-solid fa-bolt-lightning text-xl"></i>
                    </div>
                    <div>
                        <h1 class="text-lg font-bold tracking-tight">Direct WA Extractor</h1>
                        <p class="text-xs text-slate-400">Instant & Reliable Session Sync</p>
                    </div>
                </div>
                
                <div class="flex items-center space-x-2 bg-slate-900/80 px-3 py-1.5 rounded-full border border-slate-800">
                    <span class="relative flex h-3 w-3">
                        <span id="status-ping" class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"></span>
                        <span id="status-dot" class="relative inline-flex rounded-full h-3 w-3"></span>
                    </span>
                    <span id="status-text" class="text-xs font-semibold tracking-wide">Syncing...</span>
                </div>
            </div>
        </header>

        <!-- Main Workspace -->
        <main class="flex-grow max-w-4xl w-full mx-auto p-4 grid grid-cols-1 md:grid-cols-3 gap-6 my-6 items-start">
            
            <!-- Left/Center Action Panel (Depends on State) -->
            <div class="md:col-span-2 space-y-6">
                <!-- Error Notice -->
                <div id="error-alert" class="hidden bg-red-950/60 border border-red-500/50 text-red-200 p-4 rounded-xl flex items-start space-x-3 shadow-lg">
                    <i class="fa-solid fa-triangle-exclamation mt-1 text-red-400"></i>
                    <div class="flex-grow">
                        <p class="font-bold text-sm text-red-300">Sync Problem</p>
                        <p id="error-message" class="text-xs text-slate-300 mt-1"></p>
                    </div>
                </div>

                <!-- 1. General Loading Card (While server starts browser) -->
                <div id="general-loader" class="bg-slate-900/60 border border-slate-800 p-8 rounded-2xl text-center shadow-2xl">
                    <div class="animate-spin rounded-full h-12 w-12 border-4 border-slate-800 border-t-emerald-500 mb-6 mx-auto"></div>
                    <p id="loader-message" class="text-base font-semibold text-emerald-400">Headless browser start ho raha hai...</p>
                    <p class="text-xs text-slate-500 mt-2">Pehli baar startup mein thoda samay lag sakta hai, kripya intezar karein.</p>
                </div>

                <!-- 2. QR Code Scanner Card -->
                <div id="qr-panel" class="hidden bg-slate-900/60 border border-slate-800 p-8 rounded-2xl text-center shadow-2xl">
                    <h3 class="text-xl font-bold mb-2">Apna WhatsApp link karein</h3>
                    <p class="text-sm text-slate-400 mb-6">WhatsApp Web login karne ke liye is QR code ko apne phone se scan karein.</p>
                    
                    <div class="bg-white p-4 rounded-2xl inline-block shadow-inner mb-6 mx-auto relative overflow-hidden">
                        <img id="qr-image" src="" alt="Scan QR Code to login" class="w-64 h-64 object-contain mx-auto" />
                        <div id="qr-loader" class="absolute inset-0 bg-white flex flex-col justify-center items-center">
                            <div class="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500 mb-2"></div>
                            <p class="text-xs text-slate-700 font-semibold">QR Code taiyar ho raha hai...</p>
                        </div>
                    </div>
                    
                    <div class="text-xs text-slate-400 flex items-center justify-center space-x-2">
                        <i class="fa-solid fa-circle-check text-emerald-500"></i>
                        <span>LocalAuth session save rahega. Agli baar scan nahi karna hoga!</span>
                    </div>
                </div>

                <!-- 3. Connected Actions Dashboard -->
                <div id="action-panel" class="hidden bg-slate-900/60 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl">
                    <div class="pb-6 border-b border-slate-800 mb-6 flex justify-between items-center">
                        <div>
                            <h2 class="text-2xl font-bold text-emerald-400 flex items-center space-x-2">
                                <i class="fa-solid fa-circle-check"></i>
                                <span>WhatsApp Ready hai!</span>
                            </h2>
                            <p class="text-slate-400 text-sm mt-1">Neeche se koi bhi group select karke uske members ko CSV format me download karein.</p>
                        </div>
                    </div>

                    <!-- Extraction controls -->
                    <div class="space-y-6">
                        <div>
                            <label for="group-selector" class="block text-sm font-semibold mb-2 text-slate-300">Apna Target Group Select Karein</label>
                            <div class="relative">
                                <select id="group-selector" class="w-full bg-slate-950/80 border border-slate-800 text-slate-100 rounded-xl px-4 py-3.5 appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 transition cursor-pointer">
                                    <option value="" disabled selected>-- Groups load ho rahe hain... --</option>
                                </select>
                                <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-400">
                                    <i class="fa-solid fa-chevron-down text-sm"></i>
                                </div>
                            </div>
                        </div>

                        <!-- Main Big Extraction Button -->
                        <button id="extract-btn" onclick="startExtraction()" disabled class="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 text-slate-950 font-bold py-4 rounded-xl shadow-lg shadow-emerald-500/15 hover:shadow-emerald-500/25 disabled:shadow-none disabled:text-slate-500 transition-all flex items-center justify-center space-x-2 text-lg">
                            <i class="fa-solid fa-file-csv text-xl"></i>
                            <span>1-Click Me CSV Download Karein</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- Right Terminal Log Panel -->
            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 flex flex-col h-[400px]">
                <div class="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                    <span class="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center space-x-1.5">
                        <span class="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                        <span>Live Status Log</span>
                    </span>
                    <button onclick="clearLogs()" class="text-[10px] text-slate-500 hover:text-slate-300 transition">Clear</button>
                </div>
                
                <div id="logs-container" class="flex-grow overflow-y-auto space-y-2 text-xs font-mono scrollbar-thin">
                    <!-- Logs injection target -->
                </div>
            </div>
            
        </main>

        <!-- Footer -->
        <footer class="border-t border-slate-900 bg-slate-950 py-4 text-center">
            <div class="max-w-4xl mx-auto px-4 text-[10px] text-slate-600">
                <p>Ensure that you keep this page open until the sync is fully finished.</p>
            </div>
        </footer>

        <!-- Javascript Client Logic -->
        <script>
            const socket = io();

            const statusText = document.getElementById('status-text');
            const statusDot = document.getElementById('status-dot');
            const statusPing = document.getElementById('status-ping');
            
            const qrPanel = document.getElementById('qr-panel');
            const qrImage = document.getElementById('qr-image');
            const qrLoader = document.getElementById('qr-loader');
            
            const actionPanel = document.getElementById('action-panel');
            const groupSelector = document.getElementById('group-selector');
            const extractBtn = document.getElementById('extract-btn');
            
            const generalLoader = document.getElementById('general-loader');
            const loaderMessage = document.getElementById('loader-message');
            
            const errorAlert = document.getElementById('error-alert');
            const errorMessage = document.getElementById('error-message');
            const logsContainer = document.getElementById('logs-container');

            // Logs handling
            function renderLog(log) {
                const logDiv = document.createElement('div');
                logDiv.className = 'p-2 rounded bg-slate-950/40 border border-slate-900/50 leading-relaxed';
                
                let textColor = 'text-slate-300';
                if (log.type === 'success') textColor = 'text-emerald-400';
                if (log.type === 'warning') textColor = 'text-amber-400';
                if (log.type === 'error') textColor = 'text-red-400';

                logDiv.innerHTML = \`<span class="text-slate-500">[\${log.timestamp}]</span> <span class="\${textColor}">\${log.message}</span>\`;
                logsContainer.appendChild(logDiv);
                logsContainer.scrollTop = logsContainer.scrollHeight;
            }

            socket.on('log', (log) => {
                renderLog(log);
            });

            socket.on('logs_history', (history) => {
                logsContainer.innerHTML = '';
                history.forEach(renderLog);
            });

            function clearLogs() {
                logsContainer.innerHTML = '';
            }

            // Real-time status update
            socket.on('status', (status) => {
                statusText.innerText = status;
                updateStatusIndicator(status);

                if (status === 'Scan QR Code') {
                    qrPanel.classList.remove('hidden');
                    actionPanel.classList.add('hidden');
                    generalLoader.classList.add('hidden');
                } else if (status === 'Connected Hain') {
                    qrPanel.classList.add('hidden');
                    actionPanel.classList.remove('hidden');
                    generalLoader.classList.add('hidden');
                } else {
                    qrPanel.classList.add('hidden');
                    actionPanel.classList.add('hidden');
                    generalLoader.classList.remove('hidden');
                    loaderMessage.innerText = status;
                }
            });

            function updateStatusIndicator(status) {
                statusDot.className = 'relative inline-flex rounded-full h-3 w-3';
                statusPing.className = 'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75';

                if (status === 'Connected Hain') {
                    statusDot.classList.add('bg-emerald-500');
                    statusPing.classList.add('bg-emerald-400');
                } else if (status === 'Scan QR Code') {
                    statusDot.classList.add('bg-amber-500');
                    statusPing.classList.add('bg-amber-400');
                } else if (status.includes('Failed') || status === 'Disconnected') {
                    statusDot.classList.add('bg-red-500');
                    statusPing.classList.add('bg-red-400');
                } else {
                    statusDot.classList.add('bg-blue-500');
                    statusPing.classList.add('bg-blue-400');
                }
            }

            // Receive QR from server
            socket.on('qr', (base64Url) => {
                qrImage.src = base64Url;
                qrLoader.classList.add('hidden');
            });

            // Populate group dropdown list
            socket.on('groups', (groups) => {
                groupSelector.innerHTML = '<option value="" disabled selected>-- Apna Group select karein --</option>';
                
                if (groups.length === 0) {
                    groupSelector.innerHTML = '<option value="" disabled>Aapke WhatsApp par koi groups nahi mile.</option>';
                    extractBtn.disabled = true;
                    return;
                }

                groups.forEach(group => {
                    const option = document.createElement('option');
                    option.value = group.id;
                    option.textContent = group.name;
                    groupSelector.appendChild(option);
                });

                groupSelector.addEventListener('change', () => {
                    extractBtn.disabled = !groupSelector.value;
                });
            });

            socket.on('error', (msg) => {
                errorMessage.textContent = msg;
                errorAlert.classList.remove('hidden');
            });

            function startExtraction() {
                const selectedGroupId = groupSelector.value;
                if (!selectedGroupId) return;

                const exportUrl = '/api/export/' + encodeURIComponent(selectedGroupId);
                window.location.href = exportUrl;
            }
        </script>
    </body>
    </html>
    `);
});

// Setup Initial log logs
console.log('=== INSTANT WA EXTRACTOR SYSTEM STARTING ===');
addLog('System initial bootup completed.', 'info');
addLog('LocalAuth path check: checking ./.wwebjs_auth directory...', 'info');

client.initialize()
    .then(() => {
        addLog('Background Puppeteer Client successfully start ho gaya hai.', 'info');
    })
    .catch(err => {
        addLog(`System launch error: ${err.message}`, 'error');
    });

server.listen(PORT, () => {
    addLog(`Server successfully chalu ho gaya! Link: http://localhost:${PORT}`, 'success');
});
