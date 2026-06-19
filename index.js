/**
 * WhatsApp Group Contact Extractor
 * * Features:
 * - Single-file architecture (Express server + Socket.io + Frontend HTML).
 * - Real-time QR Code streaming via WebSockets.
 * - Auto-detects active WhatsApp sessions (remembers login using LocalAuth).
 * - Live group list population once logged in.
 * - One-click CSV generation containing Name, Phone Number, and Admin Status.
 * * Dependencies:
 * npm install express socket.io whatsapp-web.js qrcode
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

// Initialize WhatsApp Client with Local Auth (stores session in .wwebjs_auth)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

let currentStatus = 'Initializing...';
let latestQrCode = null;
let activeGroups = [];

// Handle WhatsApp Client Events
client.on('qr', (qr) => {
    currentStatus = 'Scan QR Code';
    latestQrCode = qr;
    
    // Convert QR text to Base64 image url
    QRCode.toDataURL(qr, (err, url) => {
        if (!err) {
            io.emit('qr', url);
            io.emit('status', currentStatus);
        }
    });
});

client.on('ready', async () => {
    currentStatus = 'Connected';
    latestQrCode = null;
    io.emit('status', currentStatus);
    console.log('WhatsApp Client is Ready!');

    try {
        // Fetch chats and filter for groups
        const chats = await client.getChats();
        activeGroups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name || 'Unnamed Group',
                unreadCount: chat.unreadCount
            }));
        
        io.emit('groups', activeGroups);
    } catch (err) {
        console.error('Error fetching groups:', err);
        io.emit('error', 'Failed to retrieve groups. Please refresh.');
    }
});

client.on('authenticated', () => {
    currentStatus = 'Authenticated (Syncing...)';
    io.emit('status', currentStatus);
});

client.on('auth_failure', (msg) => {
    currentStatus = 'Authentication Failed';
    io.emit('status', currentStatus);
    io.emit('error', 'Auth failure: ' + msg);
});

client.on('disconnected', (reason) => {
    currentStatus = 'Disconnected';
    latestQrCode = null;
    activeGroups = [];
    io.emit('status', currentStatus);
    io.emit('disconnected', reason);
    console.log('Client was logged out:', reason);
    
    // Reinitialize client to generate a new QR
    client.initialize().catch(err => console.error("Error re-initializing client:", err));
});

// Socket.io Real-time connection handler
io.on('connection', (socket) => {
    console.log('Web client connected');
    
    // Send immediate current state to the newly connected user
    socket.emit('status', currentStatus);
    
    if (latestQrCode) {
        QRCode.toDataURL(latestQrCode, (err, url) => {
            if (!err) socket.emit('qr', url);
        });
    }
    
    if (activeGroups.length > 0) {
        socket.emit('groups', activeGroups);
    }

    socket.on('disconnect', () => {
        console.log('Web client disconnected');
    });
});

// Route to handle CSV extraction
app.get('/api/export/:groupId', async (req, res) => {
    try {
        if (currentStatus !== 'Connected') {
            return res.status(400).send('WhatsApp client is not logged in.');
        }

        const groupId = req.params.groupId;
        console.log(`Exporting contacts for group ID: ${groupId}`);

        const chat = await client.getChatById(groupId);
        if (!chat.isGroup) {
            return res.status(400).send('Selected chat is not a group.');
        }

        // CSV Header
        let csvRows = ['Phone Number,Formatted ID,Display Name,Is Admin\n'];

        for (const participant of chat.participants) {
            const contact = await client.getContactById(participant.id._serialized);
            
            const rawNumber = participant.id.user;
            const serializedId = participant.id._serialized;
            const displayName = contact.pushname || contact.name || 'Unknown Contact';
            const isAdmin = participant.isAdmin || participant.isSuperAdmin ? 'Admin' : 'Member';

            // Escape fields to maintain CSV compliance
            const escapedName = `"${displayName.replace(/"/g, '""')}"`;
            csvRows.push(`${rawNumber},${serializedId},${escapedName},${isAdmin}\n`);
        }

        const sanitizedFileName = (chat.name || 'group_contacts')
            .replace(/[^a-z0-9]/gi, '_')
            .toLowerCase();

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFileName}_members.csv"`);
        res.send(csvRows.join(''));

    } catch (err) {
        console.error('CSV Export Error:', err);
        res.status(500).send('Error generating export file: ' + err.message);
    }
});

// Serve frontend directly from string
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en" class="h-full bg-slate-900">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Contact Extractor</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="/socket.io/socket.io.js"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="h-full flex flex-col justify-between text-slate-100 font-sans">
        
        <!-- Header -->
        <header class="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-50">
            <div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
                <div class="flex items-center space-x-3">
                    <div class="bg-emerald-500 p-2 rounded-xl text-slate-950 flex items-center justify-center">
                        <i class="fa-brands fa-whatsapp text-2xl"></i>
                    </div>
                    <div>
                        <h1 class="text-lg font-bold tracking-tight">WA Exporter</h1>
                        <p class="text-xs text-slate-400">Export Group Members to CSV</p>
                    </div>
                </div>
                
                <div class="flex items-center space-x-2">
                    <span class="relative flex h-3 w-3">
                        <span id="status-ping" class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"></span>
                        <span id="status-dot" class="relative inline-flex rounded-full h-3 w-3"></span>
                    </span>
                    <span id="status-text" class="text-sm font-semibold tracking-wide">Initializing...</span>
                </div>
            </div>
        </header>

        <!-- Main Body -->
        <main class="flex-grow max-w-4xl w-full mx-auto p-4 flex flex-col items-center justify-center my-6">
            
            <!-- Notification Alert -->
            <div id="error-alert" class="hidden w-full mb-6 bg-red-900/40 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg flex items-start space-x-3">
                <i class="fa-solid fa-circle-exclamation mt-1"></i>
                <div class="flex-grow">
                    <p class="font-semibold text-sm">Operation Notice</p>
                    <p id="error-message" class="text-xs text-red-300"></p>
                </div>
                <button onclick="this.parentElement.classList.add('hidden')" class="text-red-400 hover:text-red-200">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <!-- Login Panel (QR Container) -->
            <div id="qr-panel" class="hidden bg-slate-800/60 border border-slate-700 p-8 rounded-2xl max-w-sm w-full text-center backdrop-blur shadow-2xl">
                <h3 class="text-xl font-bold mb-2">Link with your account</h3>
                <p class="text-sm text-slate-400 mb-6">Open WhatsApp on your phone, go to Linked Devices and scan the code below.</p>
                
                <div class="bg-white p-4 rounded-xl inline-block shadow-inner mb-6 mx-auto relative group overflow-hidden">
                    <img id="qr-image" src="" alt="Scan QR Code to login" class="w-64 h-64 object-contain mx-auto" />
                    <div id="qr-loader" class="absolute inset-0 bg-white flex flex-col justify-center items-center">
                        <div class="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500 mb-2"></div>
                        <p class="text-xs text-slate-700">Waiting for WhatsApp...</p>
                    </div>
                </div>
                
                <div class="text-xs text-slate-400 flex items-center justify-center space-x-1.5">
                    <i class="fa-solid fa-shield-halved text-emerald-500"></i>
                    <span>Secure session storage with LocalAuth strategy.</span>
                </div>
            </div>

            <!-- Extraction Panel (After successful login) -->
            <div id="action-panel" class="hidden w-full bg-slate-800/40 border border-slate-700/80 rounded-2xl p-6 md:p-8 backdrop-blur shadow-xl">
                <div class="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-slate-700/60 mb-6 gap-4">
                    <div>
                        <h2 class="text-2xl font-bold flex items-center space-x-2">
                            <span>Ready to Extract</span>
                        </h2>
                        <p class="text-slate-400 text-sm">Select any group chat you are currently in to download its participant numbers.</p>
                    </div>
                    
                    <button id="logout-btn" onclick="triggerRestart()" class="text-xs text-red-400 bg-red-950/30 hover:bg-red-900/40 border border-red-900/50 hover:border-red-700/50 px-3 py-2 rounded-lg transition flex items-center space-x-1.5 self-start md:self-center">
                        <i class="fa-solid fa-power-off"></i>
                        <span>Disconnect Account</span>
                    </button>
                </div>

                <!-- Form Controls -->
                <div class="space-y-6">
                    <div>
                        <label for="group-selector" class="block text-sm font-semibold mb-2 text-slate-300">Select Target Group</label>
                        <div class="relative">
                            <select id="group-selector" class="w-full bg-slate-900/80 border border-slate-700 text-slate-100 rounded-xl px-4 py-3.5 appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 transition cursor-pointer">
                                <option value="" disabled selected>-- Fetching your groups... --</option>
                            </select>
                            <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-400">
                                <i class="fa-solid fa-chevron-down text-sm"></i>
                            </div>
                        </div>
                    </div>

                    <!-- Extraction Button -->
                    <button id="extract-btn" onclick="startExtraction()" disabled class="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 text-slate-950 font-bold py-4 rounded-xl shadow-lg shadow-emerald-500/10 hover:shadow-emerald-500/20 disabled:shadow-none hover:-translate-y-0.5 active:translate-y-0 disabled:translate-y-0 disabled:text-slate-400 transition-all flex items-center justify-center space-x-2 text-lg">
                        <i class="fa-solid fa-file-csv text-xl"></i>
                        <span>Download Contacts CSV</span>
                    </button>
                </div>
            </div>

            <!-- Loading Spinner (General State) -->
            <div id="general-loader" class="flex flex-col items-center">
                <div class="animate-spin rounded-full h-12 w-12 border-4 border-slate-800 border-t-emerald-500 mb-4"></div>
                <p id="loader-message" class="text-sm text-slate-400">Synchronizing background browser process...</p>
            </div>
            
        </main>

        <!-- Footer -->
        <footer class="border-t border-slate-800 bg-slate-950/20 py-4 text-center">
            <div class="max-w-4xl mx-auto px-4 text-xs text-slate-500">
                <p>Ensure you run this tool in accordance with WhatsApp's Fair Usage Guidelines and Terms of Service.</p>
            </div>
        </footer>

        <!-- Application Client Logic -->
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

            // Listen to real-time status updates from Server
            socket.on('status', (status) => {
                statusText.innerText = status;
                updateStatusIndicator(status);

                if (status === 'Scan QR Code') {
                    showPanel('qr');
                } else if (status === 'Connected') {
                    showPanel('action');
                } else {
                    showPanel('loading');
                    loaderMessage.innerText = status;
                }
            });

            // Update color configurations of top-right status dot
            function updateStatusIndicator(status) {
                statusDot.className = 'relative inline-flex rounded-full h-3 w-3';
                statusPing.className = 'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75';

                if (status === 'Connected') {
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

            // Listen for QR updates
            socket.on('qr', (base64Url) => {
                qrImage.src = base64Url;
                qrLoader.classList.add('hidden'); // Hide loader once image loads
            });

            // Listen for group lists populate
            socket.on('groups', (groups) => {
                groupSelector.innerHTML = '<option value="" disabled selected>-- Select a WhatsApp Group --</option>';
                
                if (groups.length === 0) {
                    groupSelector.innerHTML = '<option value="" disabled>No active group chats found.</option>';
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

            // Handle errors
            socket.on('error', (msg) => {
                errorMessage.textContent = msg;
                errorAlert.classList.remove('hidden');
            });

            // Clean UI navigation logic
            function showPanel(panelName) {
                qrPanel.classList.add('hidden');
                actionPanel.classList.add('hidden');
                generalLoader.classList.add('hidden');

                if (panelName === 'qr') {
                    qrPanel.classList.remove('hidden');
                } else if (panelName === 'action') {
                    actionPanel.classList.remove('hidden');
                } else {
                    generalLoader.classList.remove('hidden');
                }
            }

            // Redirect user to the CSV export endpoint
            function startExtraction() {
                const selectedGroupId = groupSelector.value;
                if (!selectedGroupId) return;

                // Create a temporary link to download CSV asynchronously
                const exportUrl = '/api/export/' + encodeURIComponent(selectedGroupId);
                window.location.href = exportUrl;
            }

            // Disconnect Account placeholder
            function triggerRestart() {
                if (confirm('Are you sure you want to log out and clear your WhatsApp session?')) {
                    window.location.reload();
                }
            }
        </script>
    </body>
    </html>
    `);
});

// Start initialization of the WhatsApp instance on server boot
console.log('Spawning headless browser instance & initializing WhatsApp Client...');
client.initialize().catch(err => {
    console.error('Initial startup failed:', err);
});

// Run server
server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
