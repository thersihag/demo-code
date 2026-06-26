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
    <body class="bg-gray-50 font-sans text-gray-800 h-screen overflow-hidden flex items-center justify-center">
        
        <!-- Toast Notification -->
        <div id="toast" class="fixed top-4 right-4 bg-green-600 text-white px-6 py-3 rounded shadow-lg transform transition-transform translate-x-full duration-300 z-50">Copied!</div>

        <!-- Auth Section -->
        <div id="auth-section" class="max-w-xl w-full bg-white p-8 rounded-xl shadow-lg border border-gray-100 text-center flex flex-col items-center transition-all">
            <h1 class="text-3xl font-extrabold mb-6 text-green-600">WhatsApp Login</h1>
            <h2 id="status-text" class="text-lg font-semibold text-gray-700 mb-4 bg-gray-100 px-4 py-2 rounded-full inline-block">Checking connection status...</h2>
            <div id="qr-container" class="hidden">
                <p class="text-sm text-gray-500 mb-2">Scan this QR code with your WhatsApp to login</p>
                <img id="qr-image" src="" alt="QR Code" class="mx-auto w-72 h-72 border-4 border-gray-100 rounded-lg shadow-sm">
            </div>
        </div>

        <!-- Main UI (Hidden until connected) -->
        <div id="main-ui" class="hidden w-full h-full flex">
            
            <!-- Left Panel: Groups List -->
            <div class="w-1/3 bg-white border-r border-gray-200 flex flex-col h-full shadow-md z-10">
                <div class="p-4 border-b bg-gray-50 flex justify-between items-center">
                    <h2 class="text-xl font-bold text-gray-800">Your Groups</h2>
                    <span id="group-count" class="bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded-full">0</span>
                </div>
                <div id="loading-groups" class="text-center text-gray-500 py-4 hidden">Fetching groups...</div>
                <div id="groups-list" class="overflow-y-auto flex-1 p-2 space-y-2">
                    <!-- Groups populate here -->
                </div>
            </div>

            <!-- Right Panel: Member Details -->
            <div class="w-2/3 bg-gray-50 flex flex-col h-full">
                <!-- Empty State -->
                <div id="right-empty" class="flex-1 flex flex-col items-center justify-center text-gray-400">
                    <svg class="w-16 h-16 mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                    <p class="text-lg">Select a group from the left to view members</p>
                </div>
                
                <!-- Content State -->
                <div id="right-content" class="hidden flex-col h-full">
                    <div class="p-4 border-b bg-white shadow-sm flex justify-between items-center z-10">
                        <div>
                            <h2 id="selected-group-name" class="text-xl font-bold text-gray-800 line-clamp-1">Group Name</h2>
                            <p id="selected-group-count" class="text-sm text-gray-500">0 Participants</p>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="copyCurrentMembers()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-sm flex items-center gap-2 transition-colors">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
                                Copy Numbers
                            </button>
                            <a id="download-csv-btn" href="#" class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg shadow-sm flex items-center gap-2 transition-colors" download>
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                CSV
                            </a>
                        </div>
                    </div>
                    <div class="flex-1 overflow-y-auto p-6">
                        <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                            <ul id="members-list" class="divide-y divide-gray-100">
                                <!-- Members go here -->
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let isConnected = false;
            let currentMembers = [];

            // Polling loop to check WhatsApp connection status
            async function checkStatus() {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();
                    
                    const statusText = document.getElementById('status-text');
                    const qrContainer = document.getElementById('qr-container');
                    const qrImage = document.getElementById('qr-image');
                    const authSection = document.getElementById('auth-section');
                    const mainUi = document.getElementById('main-ui');

                    if (data.status === 'DISCONNECTED' && data.qr) {
                        statusText.innerText = 'Status: Waiting for QR Scan';
                        statusText.className = 'text-lg font-semibold text-yellow-600 mb-4 bg-yellow-50 px-4 py-2 rounded-full inline-block';
                        qrImage.src = data.qr;
                        qrContainer.classList.remove('hidden');
                        setTimeout(checkStatus, 3000); // check again in 3s
                    } else if (data.status === 'CONNECTED') {
                        if (!isConnected) {
                            isConnected = true;
                            // Hide Auth completely, show Main UI, remove flex center from body
                            document.body.classList.remove('items-center', 'justify-center');
                            authSection.classList.add('hidden');
                            mainUi.classList.remove('hidden');
                            loadGroups();
                        }
                    } else {
                        statusText.innerText = 'Status: Initializing / Connecting...';
                        setTimeout(checkStatus, 3000);
                    }
                } catch (e) {
                    setTimeout(checkStatus, 3000);
                }
            }

            // Fetch and render groups on the left side
            async function loadGroups() {
                const loading = document.getElementById('loading-groups');
                loading.classList.remove('hidden');
                
                try {
                    const res = await fetch('/api/groups');
                    const groups = await res.json();
                    
                    loading.classList.add('hidden');
                    document.getElementById('group-count').innerText = groups.length;
                    
                    const list = document.getElementById('groups-list');
                    list.innerHTML = '';

                    groups.forEach(group => {
                        const item = document.createElement('div');
                        item.className = 'p-3 bg-white border border-gray-100 rounded-lg shadow-sm hover:shadow hover:border-green-300 cursor-pointer transition-all';
                        item.onclick = () => selectGroup(group.id, group.subject || 'Unknown Group');
                        
                        item.innerHTML = \`
                            <h3 class="font-bold text-gray-800 line-clamp-1" title="\${group.subject}">\${group.subject || 'Unknown Group'}</h3>
                            <div class="text-sm text-gray-500 mt-1 flex items-center gap-1">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
                                \${group.size} Participants
                            </div>
                        \`;
                        list.appendChild(item);
                    });
                } catch (e) {
                    loading.innerText = 'Failed to load groups.';
                    console.error('Error fetching groups:', e);
                }
            }

            // Load members when a group is clicked
            async function selectGroup(groupId, groupName) {
                document.getElementById('right-empty').classList.add('hidden');
                document.getElementById('right-content').classList.remove('hidden');
                
                document.getElementById('selected-group-name').innerText = groupName;
                document.getElementById('selected-group-count').innerText = 'Loading members...';
                document.getElementById('members-list').innerHTML = '<li class="p-6 text-center text-gray-500">Fetching participants from WhatsApp...</li>';
                
                // Update CSV Download Link
                document.getElementById('download-csv-btn').href = '/api/groups/' + groupId + '/csv';

                try {
                    const res = await fetch('/api/groups/' + groupId + '/members');
                    const members = await res.json();
                    
                    currentMembers = members;
                    document.getElementById('selected-group-count').innerText = members.length + ' Participants';
                    
                    const list = document.getElementById('members-list');
                    list.innerHTML = '';
                    
                    members.forEach(member => {
                        const li = document.createElement('li');
                        li.className = 'p-4 flex justify-between items-center hover:bg-gray-50 transition-colors';
                        li.innerHTML = \`
                            <span class="font-medium text-gray-800 select-all">\${member.id}</span>
                            \${member.isAdmin ? '<span class="px-2 py-1 bg-blue-100 text-blue-700 text-xs font-bold rounded-full">Admin</span>' : ''}
                        \`;
                        list.appendChild(li);
                    });
                } catch (e) {
                    document.getElementById('members-list').innerHTML = '<li class="p-6 text-center text-red-500">Failed to fetch members.</li>';
                }
            }

            // Copy all currently displayed members to clipboard
            function copyCurrentMembers() {
                if (currentMembers.length === 0) return;
                
                const numbers = currentMembers.map(m => m.id).join('\\n');
                
                // iFrame safe copy technique
                const textarea = document.createElement('textarea');
                textarea.value = numbers;
                textarea.style.position = 'fixed'; // Avoid scrolling to bottom
                document.body.appendChild(textarea);
                textarea.select();
                
                try {
                    document.execCommand('copy');
                    showToast('Copied ' + currentMembers.length + ' numbers to clipboard!');
                } catch (err) {
                    showToast('Failed to copy. Please use the CSV button.', true);
                }
                
                document.body.removeChild(textarea);
            }

            // Display Toast notification
            function showToast(message, isError = false) {
                const toast = document.getElementById('toast');
                toast.innerText = message;
                
                if (isError) {
                    toast.classList.remove('bg-green-600');
                    toast.classList.add('bg-red-600');
                } else {
                    toast.classList.remove('bg-red-600');
                    toast.classList.add('bg-green-600');
                }

                toast.classList.remove('translate-x-full');
                
                setTimeout(() => {
                    toast.classList.add('translate-x-full');
                }, 3000);
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
        const groupList = Object.values(groups)
            .map(g => ({
                id: g.id,
                subject: g.subject,
                size: g.participants ? g.participants.length : 0
            }))
            .filter(g => g.size > 1) // 👈 Hide groups with 0 or 1 members (Community duplicates)
            .sort((a, b) => b.size - a.size); // Sort by largest group first

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
            // Sirf asli whatsapp number lo, hidden (@lid) aur sub-groups (@g.us) ko ignore karo
            if (!participant.id.includes('@s.whatsapp.net')) continue;

            // Extract pure phone number from JID
            const number = participant.id.split('@')[0];
            const isAdmin = (participant.admin === 'admin' || participant.admin === 'superadmin') ? 'Yes' : 'No';
            
            // Excel me format fix karne ke liye '+919999999999 likho (Single Quote ke sath)
            csvContent += `'+${number},${isAdmin}\n`;
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

// 5. Get members as JSON for the UI Right Panel
app.get('/api/groups/:id/members', async (req, res) => {
    if (sessionState.status !== 'CONNECTED' || !sessionState.sock) {
        return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
    }

    try {
        const groupId = req.params.id;
        const groupMeta = await sessionState.sock.groupMetadata(groupId);
        
        const members = groupMeta.participants
            // Sirf asli whatsapp number lo, hidden (@lid) aur sub-groups ko ignore karo
            .filter(p => p.id.includes('@s.whatsapp.net')) 
            .map(p => ({
                id: '+' + p.id.split('@')[0], // UI me display ke liye + laga diya
                isAdmin: (p.admin === 'admin' || p.admin === 'superadmin')
            }));
        
        res.json(members);
    } catch (err) {
        console.error("Error fetching members API:", err);
        res.status(500).json({ error: err.message });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`==========================================`);
    console.log(` 🚀 WhatsApp Group Extractor is Running!`);
    console.log(` 🌐 Open Dashboard: http://localhost:${port}`);
    console.log(`==========================================`);
});
