/**
 * WhatsApp Group Contact Extractor (Direct Chrome Session Sync)
 * * * Yeh tool aapke local Google Chrome ke logged-in WhatsApp session ko seedhe use karega.
 * * Kisi naye QR code ko scan karne ki zaroorat nahi padegi!
 * * * Kaise chalayein:
 * 1. Apne computer ka chal raha Google Chrome browser poori tarah band (close) kar dein 
 * (Kyunki Chrome ek time par ek hi jagah profile lock allow karta hai).
 * 2. Terminal mein run karein:
 * node index.js
 * 3. Browser mein http://localhost:3000 kholein. Aapka session pehle se connected dikhayega!
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('whatsapp-web.js');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// 1. Aapke System ke hisab se Chrome ka User Data Path dhoondhne ka function
function getChromeUserDataPath() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    } else if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    } else {
        return path.join(home, '.config', 'google-chrome');
    }
}

// 2. Chrome ke Application executable ki location dhoondhna
function getChromeExecutablePath() {
    if (process.platform === 'win32') {
        // Standard Windows 64-bit Chrome path
        return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    } else if (process.platform === 'darwin') {
        // macOS Chrome path
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else {
        // Linux Chrome path
        return '/usr/bin/google-chrome';
    }
}

const chromeDataPath = getChromeUserDataPath();
const chromeExePath = getChromeExecutablePath();

console.log('=== SYSTEM DETAILS ===');
console.log(`-> Detecting Chrome Profile Path: ${chromeDataPath}`);
console.log(`-> Detecting Chrome Executable: ${chromeExePath}`);

let currentStatus = 'Chrome Session se connect ho raha hai...';
let activeGroups = [];

// WhatsApp Client setup jo aapke Google Chrome ki Default Profile ko launch karega
const client = new Client({
    // Hum Default Google Chrome profile directory use kar rahe hain jahan session saved hai
    puppeteer: {
        headless: true, // Agar aap dekhna chahte hain ki peeche kya chal raha hai, toh ise false kar sakte hain
        executablePath: chromeExePath,
        userDataDir: chromeDataPath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--profile-directory=Default', // Aapka default login profile
            '--disable-gpu',
            '--disable-extensions'
        ]
    }
});

// Status helper
function updateStatus(newStatus) {
    currentStatus = newStatus;
    console.log(`[STATUS]: ${newStatus}`);
    io.emit('status', currentStatus);
}

// WhatsApp Events
client.on('ready', async () => {
    updateStatus('Connected Hain');
    console.log('=== SUCCESS: Aapke Chrome Session se WhatsApp successfully connect ho gaya! ===');

    try {
        console.log('Groups list fetch ki ja rahi hai...');
        const chats = await client.getChats();
        activeGroups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name || 'Bina Naam Ka Group',
                unreadCount: chat.unreadCount
            }));
        
        console.log(`Total ${activeGroups.length} groups mile!`);
        io.emit('groups', activeGroups);
    } catch (err) {
        console.error('Groups fetch karne mein error:', err);
        io.emit('error', 'Groups load nahi ho paye. Kripya page refresh karein.');
    }
});

// Agar scan ki zaroorat pad jaye (in case Chrome me login na ho)
client.on('qr', (qr) => {
    updateStatus('Error: Chrome me WhatsApp logged in nahi hai! Kripya pehle apne browser me web.whatsapp.com open karke login karein.');
    console.log('--- WARNING: Chrome mein login session nahi mila! Browser mein jaakar manual login karein. ---');
});

client.on('loading_screen', (percent, message) => {
    updateStatus(`WhatsApp Web Sync ho raha hai: ${percent}%`);
});

client.on('disconnected', (reason) => {
    activeGroups = [];
    updateStatus('Disconnected');
    console.log('Session disconnect ho gaya:', reason);
});

// Socket.io real-time connection
io.on('connection', (socket) => {
    console.log(`User connected on UI | ID: ${socket.id}`);
    socket.emit('status', currentStatus);
    
    if (activeGroups.length > 0) {
        socket.emit('groups', activeGroups);
    }
});

// CSV Export API Endpoint
app.get('/api/export/:groupId', async (req, res) => {
    try {
        if (currentStatus !== 'Connected Hain') {
            return res.status(400).send('WhatsApp abhi connected nahi hai.');
        }

        const groupId = req.params.groupId;
        console.log(`Extracting: ${groupId}`);

        const chat = await client.getChatById(groupId);
        if (!chat.isGroup) {
            return res.status(400).send('Selected chat group nahi hai.');
        }

        let csvRows = ['Phone Number,Formatted ID,Display Name,Role\n'];

        for (const participant of chat.participants) {
            // Get Contact details gracefully
            const contact = await client.getContactById(participant.id._serialized);
            const rawNumber = participant.id.user;
            const serializedId = participant.id._serialized;
            const displayName = contact.pushname || contact.name || 'Unknown Contact';
            const isAdmin = participant.isAdmin || participant.isSuperAdmin ? 'Admin' : 'Member';

            const escapedName = `"${displayName.replace(/"/g, '""')}"`;
            csvRows.push(`${rawNumber},${serializedId},${escapedName},${isAdmin}\n`);
        }

        const sanitizedFileName = (chat.name || 'group_contacts')
            .replace(/[^a-z0-9]/gi, '_')
            .toLowerCase();

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFileName}_contacts.csv"`);
        res.send(csvRows.join(''));

    } catch (err) {
        console.error('Export fail ho gaya:', err);
        res.status(500).send('Error: ' + err.message);
    }
});

// Embedded HTML UI
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en" class="h-full bg-slate-950">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WA Sync Extractor</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="/socket.io/socket.io.js"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="h-full flex flex-col justify-between text-slate-100 font-sans">
        
        <!-- Header -->
        <header class="border-b border-slate-800 bg-slate-900/40 backdrop-blur sticky top-0 z-50">
            <div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
                <div class="flex items-center space-x-3">
                    <div class="bg-emerald-500 p-2 rounded-xl text-slate-950 flex items-center justify-center">
                        <i class="fa-solid fa-bolt text-xl"></i>
                    </div>
                    <div>
                        <h1 class="text-lg font-bold tracking-tight">Direct WA Extporter</h1>
                        <p class="text-xs text-slate-400">Chrome Session se Auto-Sync</p>
                    </div>
                </div>
                
                <div class="flex items-center space-x-2">
                    <span class="relative flex h-3 w-3">
                        <span id="status-ping" class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"></span>
                        <span id="status-dot" class="relative inline-flex rounded-full h-3 w-3"></span>
                    </span>
                    <span id="status-text" class="text-sm font-semibold tracking-wide">Sync ho raha hai...</span>
                </div>
            </div>
        </header>

        <!-- Main Body -->
        <main class="flex-grow max-w-4xl w-full mx-auto p-4 flex flex-col items-center justify-center my-6">
            
            <!-- Error Notification Alert -->
            <div id="error-alert" class="hidden w-full mb-6 bg-red-950/60 border border-red-500/50 text-red-200 p-4 rounded-xl flex items-start space-x-3 shadow-lg">
                <i class="fa-solid fa-triangle-exclamation mt-1 text-red-400 text-lg"></i>
                <div class="flex-grow">
                    <p class="font-bold text-sm text-red-300">Synchronization Error</p>
                    <p id="error-message" class="text-xs text-slate-300 mt-1"></p>
                </div>
                <button onclick="this.parentElement.classList.add('hidden')" class="text-red-400 hover:text-red-200">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <!-- Loader Screen (While Connecting) -->
            <div id="general-loader" class="flex flex-col items-center bg-slate-900/60 border border-slate-800/80 p-8 rounded-2xl max-w-md w-full text-center shadow-2xl">
                <div class="animate-spin rounded-full h-12 w-12 border-4 border-slate-800 border-t-emerald-500 mb-6"></div>
                <p id="loader-message" class="text-base font-semibold text-emerald-400">Chrome profile dhoondhi ja rahi hai...</p>
                
                <div class="mt-6 text-left text-xs text-slate-400 space-y-2 border-t border-slate-800/80 pt-4 w-full">
                    <p class="font-bold text-slate-300 text-center mb-1">Zaroori Instructions:</p>
                    <p><i class="fa-solid fa-circle text-[6px] text-emerald-500 mr-1.5 align-middle"></i> Apne computer ka <b>Google Chrome</b> browser poori tarah band karein.</p>
                    <p><i class="fa-solid fa-circle text-[6px] text-emerald-500 mr-1.5 align-middle"></i> Agar Chrome chal raha hoga, toh terminal pe "Profile locked" ki error aayegi.</p>
                </div>
            </div>

            <!-- Dashboard Panel (Once connected) -->
            <div id="action-panel" class="hidden w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 backdrop-blur shadow-2xl">
                <div class="pb-6 border-b border-slate-800 mb-6">
                    <h2 class="text-2xl font-bold flex items-center space-x-2 text-emerald-400">
                        <i class="fa-solid fa-circle-check text-2xl"></i>
                        <span>Chrome Session Connected!</span>
                    </h2>
                    <p class="text-slate-400 text-sm mt-1">Aapke local Chrome browser ka account sync ho chuka hai. Kisi QR code ko scan karne ki zaroorat nahi hai.</p>
                </div>

                <!-- Main controls -->
                <div class="space-y-6">
                    <div>
                        <label for="group-selector" class="block text-sm font-semibold mb-2 text-slate-300">Target WhatsApp Group Select Karein</label>
                        <div class="relative">
                            <select id="group-selector" class="w-full bg-slate-950/80 border border-slate-800 text-slate-100 rounded-xl px-4 py-3.5 appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 transition cursor-pointer">
                                <option value="" disabled selected>-- Groups load ho rahe hain... --</option>
                            </select>
                            <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-400">
                                <i class="fa-solid fa-chevron-down text-sm"></i>
                            </div>
                        </div>
                    </div>

                    <!-- Extraction Button -->
                    <button id="extract-btn" onclick="startExtraction()" disabled class="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 text-slate-950 font-bold py-4 rounded-xl shadow-lg shadow-emerald-500/10 hover:shadow-emerald-500/20 disabled:shadow-none disabled:text-slate-500 transition-all flex items-center justify-center space-x-2 text-lg">
                        <i class="fa-solid fa-file-excel text-xl"></i>
                        <span>Ek Click me CSV Download Karein</span>
                    </button>
                </div>
            </div>
            
        </main>

        <!-- Footer -->
        <footer class="border-t border-slate-900 bg-slate-950 py-4 text-center">
            <div class="max-w-4xl mx-auto px-4 text-[10px] text-slate-600">
                <p>Ensure that you keep your system's Google Chrome closed when running the script node server.</p>
            </div>
        </footer>

        <!-- Javascript Client logic -->
        <script>
            const socket = io();

            const statusText = document.getElementById('status-text');
            const statusDot = document.getElementById('status-dot');
            const statusPing = document.getElementById('status-ping');
            
            const actionPanel = document.getElementById('action-panel');
            const groupSelector = document.getElementById('group-selector');
            const extractBtn = document.getElementById('extract-btn');
            
            const generalLoader = document.getElementById('general-loader');
            const loaderMessage = document.getElementById('loader-message');
            
            const errorAlert = document.getElementById('error-alert');
            const errorMessage = document.getElementById('error-message');

            socket.on('status', (status) => {
                statusText.innerText = status;
                updateStatusIndicator(status);

                if (status === 'Connected Hain') {
                    generalLoader.classList.add('hidden');
                    actionPanel.classList.remove('hidden');
                } else {
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
                } else if (status.includes('Error')) {
                    statusDot.classList.add('bg-red-500');
                    statusPing.classList.add('bg-red-400');
                } else {
                    statusDot.classList.add('bg-blue-500');
                    statusPing.classList.add('bg-blue-400');
                }
            }

            // Sync Group drop-downs
            socket.on('groups', (groups) => {
                groupSelector.innerHTML = '<option value="" disabled selected>-- Apna Group select karein --</option>';
                
                if (groups.length === 0) {
                    groupSelector.innerHTML = '<option value="" disabled>Aapke Chrome profile par koi groups nahi mile.</option>';
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

// App initialization
console.log('=== DIRECT CHROME EXTRACTOR BOOTING ===');
console.log('1. Checking Chrome Session...');

client.initialize()
    .then(() => {
        console.log('2. System process initialized successfully.');
    })
    .catch(err => {
        console.error('CRITICAL INITIALIZATION ERROR:', err.message);
        console.log('\n======================================');
        console.log('👉 TIP: Kripya apna normal Google Chrome browser close karein aur fir ise chalayein!');
        console.log('======================================\n');
    });

server.listen(PORT, () => {
    console.log(`3. Server running on: http://localhost:${PORT}`);
});
