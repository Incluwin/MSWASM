/**
 * P2P Social Client for MapleStory WASM
 *
 * All social data (buddies, guilds, chat history) is stored locally in
 * IndexedDB. Communication happens directly between browsers via WebRTC.
 * The only server dependency is a stateless signaling relay that helps
 * browsers find each other — it stores nothing.
 *
 * Architecture:
 *   Browser A  <──WebRTC──>  Browser B
 *       │                        │
 *       └──WebSocket──> Signaling Relay <──WebSocket──┘
 *            (SDP/ICE only, no data stored)
 */
(function () {
    "use strict";

    // ═══════════════════════════════════════════════════════════════
    // IndexedDB — Local Persistence
    // ═══════════════════════════════════════════════════════════════

    const DB_NAME = "mapleSocial";
    const DB_VERSION = 1;
    let db = null;

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains("buddies")) {
                    d.createObjectStore("buddies", { keyPath: "username" });
                }
                if (!d.objectStoreNames.contains("buddy_requests_in")) {
                    d.createObjectStore("buddy_requests_in", { keyPath: "from" });
                }
                if (!d.objectStoreNames.contains("buddy_requests_out")) {
                    d.createObjectStore("buddy_requests_out", { keyPath: "to" });
                }
                if (!d.objectStoreNames.contains("guild")) {
                    d.createObjectStore("guild", { keyPath: "key" });
                }
                if (!d.objectStoreNames.contains("guild_invites")) {
                    d.createObjectStore("guild_invites", { keyPath: "guild_name" });
                }
                if (!d.objectStoreNames.contains("chat")) {
                    const store = d.createObjectStore("chat", { keyPath: "id", autoIncrement: true });
                    store.createIndex("ts", "ts");
                }
            };
            req.onsuccess = (e) => { db = e.target.result; resolve(db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    // Generic helpers
    function dbPut(store, value) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, "readwrite");
            tx.objectStore(store).put(value);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    function dbDelete(store, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, "readwrite");
            tx.objectStore(store).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    function dbGetAll(store) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, "readonly");
            const req = tx.objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function dbGet(store, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, "readonly");
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function dbClear(store) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, "readwrite");
            tx.objectStore(store).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    // Chat-specific: save and trim
    async function saveChatMsg(channel, from, message) {
        const entry = { channel, from, message, ts: Date.now() };
        await dbPut("chat", entry);
        chatLog.push(entry);
        if (chatLog.length > MAX_CHAT_LINES) chatLog.shift();
        renderChat();
    }

    async function loadChatHistory() {
        const all = await dbGetAll("chat");
        all.sort((a, b) => a.ts - b.ts);
        chatLog = all.slice(-MAX_CHAT_LINES);
    }

    // ═══════════════════════════════════════════════════════════════
    // WebRTC — Peer Connections
    // ═══════════════════════════════════════════════════════════════

    const RTC_CONFIG = {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
        ],
    };

    // username -> { pc: RTCPeerConnection, dc: RTCDataChannel, ready: bool }
    const peerConnections = {};

    function createPeerConnection(remoteUsername, initiator) {
        if (peerConnections[remoteUsername]) {
            closePeer(remoteUsername);
        }

        const pc = new RTCPeerConnection(RTC_CONFIG);
        const entry = { pc, dc: null, ready: false };
        peerConnections[remoteUsername] = entry;

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                signalSend(remoteUsername, { type: "ice", candidate: e.candidate });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
                closePeer(remoteUsername);
                updatePresence();
            }
        };

        if (initiator) {
            const dc = pc.createDataChannel("social");
            entry.dc = dc;
            setupDataChannel(dc, remoteUsername);

            pc.createOffer().then(offer => {
                return pc.setLocalDescription(offer);
            }).then(() => {
                signalSend(remoteUsername, { type: "offer", sdp: pc.localDescription });
            });
        } else {
            pc.ondatachannel = (e) => {
                entry.dc = e.channel;
                setupDataChannel(e.channel, remoteUsername);
            };
        }

        return entry;
    }

    function setupDataChannel(dc, remoteUsername) {
        const entry = peerConnections[remoteUsername];

        dc.onopen = () => {
            console.log("[P2P] Channel open with", remoteUsername);
            if (entry) entry.ready = true;
            updatePresence();
            // Sync social state on connect
            sendSyncToPeer(remoteUsername);
        };

        dc.onclose = () => {
            console.log("[P2P] Channel closed with", remoteUsername);
            if (entry) entry.ready = false;
            updatePresence();
        };

        dc.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                handlePeerMessage(remoteUsername, msg);
            } catch { /* ignore bad data */ }
        };
    }

    function closePeer(remoteUsername) {
        const entry = peerConnections[remoteUsername];
        if (!entry) return;
        if (entry.dc) try { entry.dc.close(); } catch {}
        if (entry.pc) try { entry.pc.close(); } catch {}
        delete peerConnections[remoteUsername];
    }

    function sendToPeer(remoteUsername, msg) {
        const entry = peerConnections[remoteUsername];
        if (entry && entry.dc && entry.dc.readyState === "open") {
            entry.dc.send(JSON.stringify(msg));
            return true;
        }
        return false;
    }

    function broadcastToPeers(msg, filter) {
        const targets = filter || Object.keys(peerConnections);
        targets.forEach(name => sendToPeer(name, msg));
    }

    function getConnectedPeers() {
        return Object.keys(peerConnections).filter(name => {
            const e = peerConnections[name];
            return e && e.ready;
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // Signaling — WebSocket to Relay
    // ═══════════════════════════════════════════════════════════════

    let sigWs = null;
    let sigReconnectTimer = null;
    let onlinePeers = new Set(); // usernames from relay

    function getSocialUrl() {
        const cfg = window._mapleProfileConfig || {};
        const host = cfg.SocialServerIP || window.location.hostname || "localhost";
        const port = cfg.SocialServerPort || "8090";
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        return `${proto}://${host}:${port}`;
    }

    function sigConnect() {
        if (sigWs && sigWs.readyState <= 1) return;
        const url = getSocialUrl();
        console.log("[Signal] Connecting to", url);
        sigWs = new WebSocket(url);

        sigWs.onopen = () => {
            console.log("[Signal] Connected");
            if (username) {
                sigWs.send(JSON.stringify({ type: "register", username }));
            }
        };

        sigWs.onmessage = (evt) => {
            let data;
            try { data = JSON.parse(evt.data); } catch { return; }
            handleSignalMessage(data);
        };

        sigWs.onclose = () => {
            console.log("[Signal] Disconnected");
            onlinePeers.clear();
            updatePresence();
            sigScheduleReconnect();
        };

        sigWs.onerror = () => {};
    }

    function sigScheduleReconnect() {
        if (sigReconnectTimer) return;
        sigReconnectTimer = setTimeout(() => {
            sigReconnectTimer = null;
            sigConnect();
        }, 5000);
    }

    function signalSend(to, data) {
        if (sigWs && sigWs.readyState === 1) {
            sigWs.send(JSON.stringify({ type: "signal", to, data }));
        }
    }

    async function handleSignalMessage(data) {
        switch (data.type) {
            case "registered":
                console.log("[Signal] Registered as", data.username, "| Online:", data.online);
                setStatus("Online as " + data.username + " (" + data.online.length + " peers)");
                onlinePeers = new Set(data.online);
                // Connect to buddies and guild members who are online
                await connectToKnownPeers();
                updatePresence();
                break;

            case "peer_joined":
                onlinePeers.add(data.username);
                // Connect if they're a buddy or guild member
                await maybeConnectToPeer(data.username);
                updatePresence();
                break;

            case "peer_left":
                onlinePeers.delete(data.username);
                closePeer(data.username);
                updatePresence();
                break;

            case "signal": {
                const from = data.from;
                const sig = data.data;

                if (sig.type === "offer") {
                    // Incoming connection request
                    const entry = createPeerConnection(from, false);
                    await entry.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                    const answer = await entry.pc.createAnswer();
                    await entry.pc.setLocalDescription(answer);
                    signalSend(from, { type: "answer", sdp: entry.pc.localDescription });
                } else if (sig.type === "answer") {
                    const entry = peerConnections[from];
                    if (entry) {
                        await entry.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                    }
                } else if (sig.type === "ice") {
                    const entry = peerConnections[from];
                    if (entry) {
                        await entry.pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
                    }
                }
                break;
            }

            case "peer_offline":
                // Target not online when we tried to signal
                break;

            case "kicked":
                setStatus("Logged in from another tab");
                break;
        }
    }

    async function connectToKnownPeers() {
        const buddies = await dbGetAll("buddies");
        const guild = await loadGuild();
        const knownNames = new Set();

        buddies.forEach(b => knownNames.add(b.username));
        if (guild && guild.members) {
            guild.members.forEach(m => knownNames.add(m.username));
        }

        for (const name of knownNames) {
            if (onlinePeers.has(name) && !peerConnections[name]) {
                createPeerConnection(name, true);
            }
        }
    }

    async function maybeConnectToPeer(name) {
        if (peerConnections[name]) return;

        const buddy = await dbGet("buddies", name);
        const guild = await loadGuild();
        const isGuildMember = guild && guild.members && guild.members.some(m => m.username === name);

        if (buddy || isGuildMember) {
            createPeerConnection(name, true);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // P2P Message Protocol
    // ═══════════════════════════════════════════════════════════════

    async function handlePeerMessage(from, msg) {
        switch (msg.type) {
            // ── Chat ───────────────────────────────────────────
            case "chat":
                await saveChatMsg(msg.channel || "all", from, msg.message);
                break;

            // ── Buddy sync on connect ──────────────────────────
            case "buddy_confirm":
                // The other side says "I have you as a buddy"
                if (!(await dbGet("buddies", from))) {
                    // They have us but we don't have them — auto-accept
                    await dbPut("buddies", { username: from, addedAt: Date.now() });
                    await dbDelete("buddy_requests_out", from);
                    await dbDelete("buddy_requests_in", from);
                    await saveChatMsg("system", "System", from + " is now your buddy (synced)");
                }
                renderBuddyList();
                break;

            case "buddy_request":
                if (await dbGet("buddies", from)) {
                    // Already buddies — confirm back
                    sendToPeer(from, { type: "buddy_confirm" });
                    return;
                }
                // Check if we had a pending outgoing request to them
                if (await dbGet("buddy_requests_out", from)) {
                    // Mutual request — auto-accept
                    await dbDelete("buddy_requests_out", from);
                    await dbPut("buddies", { username: from, addedAt: Date.now() });
                    sendToPeer(from, { type: "buddy_accept" });
                    await saveChatMsg("system", "System", from + " is now your buddy!");
                } else {
                    await dbPut("buddy_requests_in", { from, ts: Date.now() });
                    await saveChatMsg("system", "System", from + " wants to be your buddy!");
                }
                renderBuddyList();
                break;

            case "buddy_accept":
                await dbDelete("buddy_requests_out", from);
                await dbPut("buddies", { username: from, addedAt: Date.now() });
                await saveChatMsg("system", "System", from + " accepted your buddy request!");
                renderBuddyList();
                break;

            case "buddy_decline":
                await dbDelete("buddy_requests_out", from);
                await saveChatMsg("system", "System", from + " declined your buddy request.");
                renderBuddyList();
                break;

            case "buddy_remove":
                await dbDelete("buddies", from);
                await saveChatMsg("system", "System", from + " removed you from their buddy list.");
                renderBuddyList();
                break;

            // ── Guild ──────────────────────────────────────────
            case "guild_invite": {
                await dbPut("guild_invites", {
                    guild_name: msg.guild_name,
                    from,
                    members: msg.members || [],
                    ts: Date.now(),
                });
                await saveChatMsg("system", "System",
                    from + " invited you to guild [" + msg.guild_name + "]");
                renderGuild();
                break;
            }

            case "guild_accept": {
                // Someone accepted our invite — add them to our guild
                const guild = await loadGuild();
                if (guild && guild.members) {
                    if (!guild.members.some(m => m.username === from)) {
                        guild.members.push({ username: from, rank: 3 });
                        await saveGuild(guild);
                        // Broadcast updated roster to all guild peers
                        await broadcastGuildSync();
                        await saveChatMsg("system", "System", from + " joined the guild!");
                        renderGuild();
                    }
                }
                break;
            }

            case "guild_decline":
                await saveChatMsg("system", "System", from + " declined the guild invite.");
                break;

            case "guild_sync": {
                // Received guild state from a peer (authoritative sync from leader/officer)
                const myGuild = await loadGuild();
                if (myGuild && myGuild.name === msg.guild.name) {
                    // Update our copy if the sender has authority (lower rank = higher authority)
                    const senderMember = msg.guild.members.find(m => m.username === from);
                    const myMember = msg.guild.members.find(m => m.username === username);
                    if (senderMember && myMember && senderMember.rank <= myMember.rank) {
                        await saveGuild(msg.guild);
                        renderGuild();
                    }
                } else if (!myGuild && msg.guild.members.some(m => m.username === username)) {
                    // We're in this guild but didn't know — accept the sync
                    await saveGuild(msg.guild);
                    renderGuild();
                }
                break;
            }

            case "guild_leave":
                await handlePeerGuildLeave(from);
                break;

            case "guild_kick":
                if (msg.target === username) {
                    await saveGuild(null);
                    await saveChatMsg("system", "System", "You were kicked from the guild by " + from);
                    renderGuild();
                } else {
                    await handlePeerGuildLeave(msg.target);
                }
                break;

            case "guild_promote": {
                const guild = await loadGuild();
                if (guild) {
                    const member = guild.members.find(m => m.username === msg.target);
                    if (member) {
                        member.rank = msg.rank;
                        if (msg.rank === 1) {
                            // Leadership transfer
                            const oldLeader = guild.members.find(m => m.username === from);
                            if (oldLeader) oldLeader.rank = 2;
                            guild.leader = msg.target;
                        }
                        await saveGuild(guild);
                        renderGuild();
                    }
                }
                break;
            }
        }
    }

    async function handlePeerGuildLeave(who) {
        const guild = await loadGuild();
        if (guild && guild.members) {
            guild.members = guild.members.filter(m => m.username !== who);
            await saveGuild(guild);
            await saveChatMsg("system", "System", who + " left the guild.");
            renderGuild();
        }
    }

    // Send our social state to a newly connected peer
    async function sendSyncToPeer(remoteName) {
        // If they're our buddy, confirm
        const buddy = await dbGet("buddies", remoteName);
        if (buddy) {
            sendToPeer(remoteName, { type: "buddy_confirm" });
        }

        // If we had a pending outgoing buddy request, re-send it
        const outReq = await dbGet("buddy_requests_out", remoteName);
        if (outReq) {
            sendToPeer(remoteName, { type: "buddy_request" });
        }

        // Sync guild if we're in the same guild
        const guild = await loadGuild();
        if (guild && guild.members && guild.members.some(m => m.username === remoteName)) {
            sendToPeer(remoteName, { type: "guild_sync", guild });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Guild Persistence Helpers
    // ═══════════════════════════════════════════════════════════════

    async function loadGuild() {
        const row = await dbGet("guild", "current");
        return row ? row.data : null;
    }

    async function saveGuild(guild) {
        if (guild) {
            await dbPut("guild", { key: "current", data: guild });
        } else {
            await dbDelete("guild", "current");
        }
    }

    async function broadcastGuildSync() {
        const guild = await loadGuild();
        if (!guild) return;
        const memberNames = guild.members.map(m => m.username).filter(n => n !== username);
        broadcastToPeers({ type: "guild_sync", guild }, memberNames);
    }

    // ═══════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════

    let username = "";
    let chatLog = [];
    const MAX_CHAT_LINES = 200;

    // ═══════════════════════════════════════════════════════════════
    // UI
    // ═══════════════════════════════════════════════════════════════

    let panel, chatArea, chatInput, buddyPanel, guildPanel, statusEl, tabBtns;
    let currentTab = "chat";
    let panelVisible = false;

    function buildUI() {
        // Toggle button
        const toggle = document.createElement("button");
        toggle.id = "social-toggle";
        toggle.textContent = "Social";
        toggle.title = "Toggle social panel";
        Object.assign(toggle.style, {
            position: "fixed", top: "8px", right: "80px", zIndex: "998",
            fontSize: "11px", padding: "4px 10px", borderRadius: "4px",
            border: "1px solid #555", background: "rgba(30,30,50,0.7)",
            color: "#aaa", cursor: "pointer", opacity: "0.5", transition: "opacity 0.2s",
        });
        toggle.addEventListener("mouseenter", () => toggle.style.opacity = "1");
        toggle.addEventListener("mouseleave", () => toggle.style.opacity = "0.5");
        toggle.addEventListener("click", togglePanel);
        document.body.appendChild(toggle);

        // Panel
        panel = document.createElement("div");
        panel.id = "social-panel";
        Object.assign(panel.style, {
            position: "fixed", top: "36px", right: "8px", width: "320px",
            maxHeight: "70vh", background: "#1a1a2e", border: "1px solid #444",
            borderRadius: "8px", display: "none", flexDirection: "column",
            zIndex: "997", fontFamily: "'Segoe UI', sans-serif", fontSize: "12px",
            color: "#e0e0e0", overflow: "hidden",
        });
        document.body.appendChild(panel);

        // Status
        statusEl = document.createElement("div");
        Object.assign(statusEl.style, {
            padding: "6px 10px", background: "#12122a", borderBottom: "1px solid #333",
            fontSize: "11px", color: "#888",
        });
        statusEl.textContent = "Not connected";
        panel.appendChild(statusEl);

        // Login area
        const loginArea = document.createElement("div");
        loginArea.id = "social-login";
        Object.assign(loginArea.style, { padding: "12px", display: "flex", gap: "6px" });
        const loginInput = document.createElement("input");
        loginInput.id = "social-login-input";
        loginInput.placeholder = "Character name";
        loginInput.maxLength = 13;
        Object.assign(loginInput.style, {
            flex: "1", padding: "6px 8px", borderRadius: "4px",
            border: "1px solid #555", background: "#2a2a3e", color: "#e0e0e0", fontSize: "12px",
        });
        const saved = localStorage.getItem("socialUsername") || "";
        if (saved) loginInput.value = saved;
        const loginBtn = document.createElement("button");
        loginBtn.textContent = "Login";
        Object.assign(loginBtn.style, {
            padding: "6px 12px", borderRadius: "4px", border: "1px solid #555",
            background: "#2d5a27", color: "#fff", cursor: "pointer", fontSize: "12px",
        });
        loginBtn.addEventListener("click", doLogin);
        loginInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") doLogin();
        });
        loginArea.appendChild(loginInput);
        loginArea.appendChild(loginBtn);
        panel.appendChild(loginArea);

        // Main area (hidden until login)
        const mainUI = document.createElement("div");
        mainUI.id = "social-main";
        mainUI.style.display = "none";
        panel.appendChild(mainUI);

        // Tabs
        const tabBar = document.createElement("div");
        Object.assign(tabBar.style, { display: "flex", borderBottom: "1px solid #333" });
        tabBtns = {};
        ["chat", "buddies", "guild"].forEach(name => {
            const btn = document.createElement("button");
            btn.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            Object.assign(btn.style, {
                flex: "1", padding: "8px", background: "none", border: "none",
                borderBottom: "2px solid transparent", color: "#888",
                cursor: "pointer", fontSize: "12px",
            });
            btn.addEventListener("click", () => switchTab(name));
            tabBar.appendChild(btn);
            tabBtns[name] = btn;
        });
        mainUI.appendChild(tabBar);

        // Chat
        chatArea = document.createElement("div");
        chatArea.id = "social-chat";
        Object.assign(chatArea.style, {
            height: "280px", overflowY: "auto", padding: "6px 10px",
            fontSize: "12px", lineHeight: "1.5",
        });
        mainUI.appendChild(chatArea);

        // Chat input row
        const chatRow = document.createElement("div");
        chatRow.id = "social-chat-row";
        Object.assign(chatRow.style, {
            display: "flex", gap: "4px", padding: "6px 8px", borderTop: "1px solid #333",
        });

        const channelSelect = document.createElement("select");
        channelSelect.id = "social-channel";
        Object.assign(channelSelect.style, {
            padding: "4px", borderRadius: "4px", border: "1px solid #555",
            background: "#2a2a3e", color: "#e0e0e0", fontSize: "11px",
        });
        [["all", "All"], ["buddy", "Buddy"], ["guild", "Guild"]].forEach(([val, label]) => {
            const opt = document.createElement("option");
            opt.value = val; opt.textContent = label;
            channelSelect.appendChild(opt);
        });
        chatRow.appendChild(channelSelect);

        chatInput = document.createElement("input");
        chatInput.id = "social-chat-input";
        chatInput.placeholder = "Type a message...";
        Object.assign(chatInput.style, {
            flex: "1", padding: "4px 8px", borderRadius: "4px",
            border: "1px solid #555", background: "#2a2a3e", color: "#e0e0e0", fontSize: "12px",
        });
        chatInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") sendChatFromInput();
        });
        chatRow.appendChild(chatInput);

        const sendBtn = document.createElement("button");
        sendBtn.textContent = "Send";
        Object.assign(sendBtn.style, {
            padding: "4px 10px", borderRadius: "4px", border: "1px solid #555",
            background: "#2a2a3e", color: "#e0e0e0", cursor: "pointer", fontSize: "11px",
        });
        sendBtn.addEventListener("click", sendChatFromInput);
        chatRow.appendChild(sendBtn);
        mainUI.appendChild(chatRow);

        // Buddies
        buddyPanel = document.createElement("div");
        buddyPanel.id = "social-buddies";
        Object.assign(buddyPanel.style, {
            height: "280px", overflowY: "auto", padding: "6px 10px", display: "none",
        });
        mainUI.appendChild(buddyPanel);

        // Guild
        guildPanel = document.createElement("div");
        guildPanel.id = "social-guild";
        Object.assign(guildPanel.style, {
            height: "280px", overflowY: "auto", padding: "6px 10px", display: "none",
        });
        mainUI.appendChild(guildPanel);

        switchTab("chat");
    }

    async function doLogin() {
        const input = document.getElementById("social-login-input");
        const name = (input.value || "").trim();
        if (!name) return;
        username = name;
        localStorage.setItem("socialUsername", name);

        // Register with signaling relay
        if (sigWs && sigWs.readyState === 1) {
            sigWs.send(JSON.stringify({ type: "register", username }));
        }

        // Load local data and show UI
        await loadChatHistory();
        document.getElementById("social-login").style.display = "none";
        document.getElementById("social-main").style.display = "";
        setStatus("Online as " + username);
        renderChat();
        renderBuddyList();
        renderGuild();
    }

    function togglePanel() {
        panelVisible = !panelVisible;
        panel.style.display = panelVisible ? "flex" : "none";
        if (panelVisible && username) {
            renderBuddyList();
            renderGuild();
        }
    }

    function setStatus(text) {
        if (statusEl) statusEl.textContent = text;
    }

    function switchTab(name) {
        currentTab = name;
        document.getElementById("social-chat").style.display = name === "chat" ? "" : "none";
        document.getElementById("social-chat-row").style.display = name === "chat" ? "flex" : "none";
        document.getElementById("social-buddies").style.display = name === "buddies" ? "" : "none";
        document.getElementById("social-guild").style.display = name === "guild" ? "" : "none";
        Object.entries(tabBtns).forEach(([key, btn]) => {
            btn.style.color = key === name ? "#fff" : "#888";
            btn.style.borderBottomColor = key === name ? "#5a8aba" : "transparent";
        });
    }

    // ── Presence helpers ───────────────────────────────────────────
    function isPeerOnline(name) {
        const e = peerConnections[name];
        return (e && e.ready) || false;
    }

    function updatePresence() {
        const connected = getConnectedPeers();
        setStatus("Online as " + username + " | " + connected.length + " peers connected");
        if (currentTab === "buddies") renderBuddyList();
        if (currentTab === "guild") renderGuild();
    }

    // ── Chat ───────────────────────────────────────────────────────
    const CHANNEL_COLORS = { all: "#ccc", buddy: "#66ccff", guild: "#66ff88", system: "#ffcc44" };

    function renderChat() {
        if (!chatArea) return;
        const wasBottom = chatArea.scrollTop + chatArea.clientHeight >= chatArea.scrollHeight - 4;
        chatArea.innerHTML = "";
        chatLog.forEach(entry => {
            const line = document.createElement("div");
            const color = CHANNEL_COLORS[entry.channel] || "#ccc";
            const tag = entry.channel !== "all" && entry.channel !== "system" ? `[${entry.channel}] ` : "";
            const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
            line.innerHTML = `<span style="color:#666">${time}</span> `
                + `<span style="color:${color}">${tag}<b>${esc(entry.from)}</b>: ${esc(entry.message)}</span>`;
            chatArea.appendChild(line);
        });
        if (wasBottom) chatArea.scrollTop = chatArea.scrollHeight;
    }

    async function sendChatFromInput() {
        const msg = chatInput.value.trim();
        if (!msg) return;
        const channel = document.getElementById("social-channel").value;

        if (channel === "buddy") {
            const spaceIdx = msg.indexOf(" ");
            if (spaceIdx === -1) {
                await saveChatMsg("system", "System", "Usage: <buddy name> <message>");
                return;
            }
            const to = msg.substring(0, spaceIdx);
            const text = msg.substring(spaceIdx + 1);
            if (sendToPeer(to, { type: "chat", channel: "buddy", message: text })) {
                await saveChatMsg("buddy", username, "[to " + to + "] " + text);
            } else {
                await saveChatMsg("system", "System", to + " is not connected.");
            }
        } else if (channel === "guild") {
            const guild = await loadGuild();
            if (!guild) {
                await saveChatMsg("system", "System", "You are not in a guild.");
                chatInput.value = "";
                return;
            }
            const memberNames = guild.members.map(m => m.username).filter(n => n !== username);
            broadcastToPeers({ type: "chat", channel: "guild", message: msg }, memberNames);
            await saveChatMsg("guild", username, msg);
        } else {
            // All = broadcast to every connected peer
            broadcastToPeers({ type: "chat", channel: "all", message: msg });
            await saveChatMsg("all", username, msg);
        }
        chatInput.value = "";
    }

    // ── Buddy List ─────────────────────────────────────────────────
    async function renderBuddyList() {
        if (!buddyPanel || !db) return;
        buddyPanel.innerHTML = "";

        // Add input
        const addRow = document.createElement("div");
        Object.assign(addRow.style, { display: "flex", gap: "4px", marginBottom: "8px" });
        const addInput = document.createElement("input");
        addInput.placeholder = "Add buddy...";
        Object.assign(addInput.style, {
            flex: "1", padding: "4px 8px", borderRadius: "4px",
            border: "1px solid #555", background: "#2a2a3e", color: "#e0e0e0", fontSize: "12px",
        });
        addInput.addEventListener("keydown", (e) => e.stopPropagation());
        addRow.appendChild(addInput);
        addRow.appendChild(makeBtn("Add", async () => {
            const name = addInput.value.trim();
            if (!name || name === username) return;
            await dbPut("buddy_requests_out", { to: name, ts: Date.now() });
            // If they're connected, send directly
            if (sendToPeer(name, { type: "buddy_request" })) {
                await saveChatMsg("system", "System", "Buddy request sent to " + name);
            } else {
                await saveChatMsg("system", "System",
                    "Buddy request saved for " + name + ". It will be sent when you're both online.");
            }
            addInput.value = "";
            renderBuddyList();
        }));
        buddyPanel.appendChild(addRow);

        // Pending incoming
        const incoming = await dbGetAll("buddy_requests_in");
        if (incoming.length > 0) {
            const header = document.createElement("div");
            header.style.color = "#ffcc44";
            header.style.marginBottom = "4px";
            header.textContent = "Pending Requests";
            buddyPanel.appendChild(header);

            incoming.forEach(req => {
                const row = document.createElement("div");
                Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", padding: "3px 0" });
                row.innerHTML = `<span>${esc(req.from)}</span>`;
                row.appendChild(makeBtn("Accept", async () => {
                    await dbDelete("buddy_requests_in", req.from);
                    await dbPut("buddies", { username: req.from, addedAt: Date.now() });
                    sendToPeer(req.from, { type: "buddy_accept" });
                    await saveChatMsg("system", "System", req.from + " is now your buddy!");
                    // Connect to them if online
                    if (onlinePeers.has(req.from) && !peerConnections[req.from]) {
                        createPeerConnection(req.from, true);
                    }
                    renderBuddyList();
                }));
                row.appendChild(makeBtn("Decline", async () => {
                    await dbDelete("buddy_requests_in", req.from);
                    sendToPeer(req.from, { type: "buddy_decline" });
                    renderBuddyList();
                }));
                buddyPanel.appendChild(row);
            });
        }

        // Pending outgoing
        const outgoing = await dbGetAll("buddy_requests_out");
        if (outgoing.length > 0) {
            const header = document.createElement("div");
            header.style.color = "#aaa";
            header.style.marginBottom = "4px";
            header.style.marginTop = "6px";
            header.textContent = "Sent Requests (waiting)";
            buddyPanel.appendChild(header);

            outgoing.forEach(req => {
                const row = document.createElement("div");
                Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", padding: "3px 0" });
                const dot = onlinePeers.has(req.to) ? '<span style="color:#ff4">~</span>' : '<span style="color:#666">~</span>';
                row.innerHTML = `${dot} <span style="color:#aaa;flex:1">${esc(req.to)}</span>`;
                row.appendChild(makeBtn("Cancel", async () => {
                    await dbDelete("buddy_requests_out", req.to);
                    renderBuddyList();
                }));
                buddyPanel.appendChild(row);
            });
        }

        // Buddy list
        const buddies = await dbGetAll("buddies");
        if (buddies.length === 0 && incoming.length === 0 && outgoing.length === 0) {
            buddyPanel.innerHTML += '<div style="color:#666;padding:8px 0">No buddies yet. Add one above!</div>';
            return;
        }

        const online = buddies.filter(b => isPeerOnline(b.username)).sort((a, b) => a.username.localeCompare(b.username));
        const offline = buddies.filter(b => !isPeerOnline(b.username)).sort((a, b) => a.username.localeCompare(b.username));

        [...online, ...offline].forEach(buddy => {
            const isOn = isPeerOnline(buddy.username);
            const row = document.createElement("div");
            Object.assign(row.style, {
                display: "flex", alignItems: "center", gap: "6px",
                padding: "3px 0", borderBottom: "1px solid #222",
            });
            const dot = isOn ? '<span style="color:#4f4">●</span>' : '<span style="color:#666">●</span>';
            const col = isOn ? "color:#e0e0e0" : "color:#666";
            row.innerHTML = `${dot} <span style="${col};flex:1">${esc(buddy.username)}</span>`;
            row.appendChild(makeBtn("Whisper", () => {
                switchTab("chat");
                document.getElementById("social-channel").value = "buddy";
                chatInput.value = buddy.username + " ";
                chatInput.focus();
            }));
            row.appendChild(makeBtn("Remove", async () => {
                await dbDelete("buddies", buddy.username);
                sendToPeer(buddy.username, { type: "buddy_remove" });
                closePeer(buddy.username);
                renderBuddyList();
            }));
            buddyPanel.appendChild(row);
        });
    }

    // ── Guild ──────────────────────────────────────────────────────
    async function renderGuild() {
        if (!guildPanel || !db) return;
        guildPanel.innerHTML = "";

        // Pending invites
        const invites = await dbGetAll("guild_invites");
        invites.forEach(inv => {
            const row = document.createElement("div");
            Object.assign(row.style, {
                padding: "6px", marginBottom: "8px", background: "#2a2a3e",
                borderRadius: "4px", border: "1px solid #555",
            });
            row.innerHTML = `<div style="margin-bottom:4px">${esc(inv.from)} invited you to <b>${esc(inv.guild_name)}</b></div>`;
            row.appendChild(makeBtn("Accept", async () => {
                const guildData = {
                    name: inv.guild_name,
                    leader: inv.from,
                    members: [...(inv.members || [])],
                };
                // Add ourselves if not present
                if (!guildData.members.some(m => m.username === username)) {
                    guildData.members.push({ username, rank: 3 });
                }
                await saveGuild(guildData);
                await dbDelete("guild_invites", inv.guild_name);
                sendToPeer(inv.from, { type: "guild_accept" });
                // Connect to guild members
                for (const m of guildData.members) {
                    if (m.username !== username && onlinePeers.has(m.username) && !peerConnections[m.username]) {
                        createPeerConnection(m.username, true);
                    }
                }
                renderGuild();
            }));
            row.appendChild(makeBtn("Decline", async () => {
                await dbDelete("guild_invites", inv.guild_name);
                sendToPeer(inv.from, { type: "guild_decline" });
                renderGuild();
            }));
            guildPanel.appendChild(row);
        });

        const guild = await loadGuild();

        if (!guild) {
            const createRow = document.createElement("div");
            Object.assign(createRow.style, { display: "flex", gap: "4px", marginBottom: "8px" });
            const nameInput = document.createElement("input");
            nameInput.placeholder = "Guild name...";
            Object.assign(nameInput.style, {
                flex: "1", padding: "4px 8px", borderRadius: "4px",
                border: "1px solid #555", background: "#2a2a3e", color: "#e0e0e0", fontSize: "12px",
            });
            nameInput.addEventListener("keydown", (e) => e.stopPropagation());
            createRow.appendChild(nameInput);
            createRow.appendChild(makeBtn("Create Guild", async () => {
                const name = nameInput.value.trim();
                if (!name) return;
                await saveGuild({
                    name,
                    leader: username,
                    members: [{ username, rank: 1 }],
                });
                await saveChatMsg("system", "System", "Created guild [" + name + "]!");
                renderGuild();
            }));
            guildPanel.appendChild(createRow);
            if (invites.length === 0) {
                guildPanel.innerHTML += '<div style="color:#666;padding:8px 0">You are not in a guild.</div>';
            }
            return;
        }

        // Header
        const header = document.createElement("div");
        Object.assign(header.style, { marginBottom: "8px" });
        header.innerHTML = `<div style="font-size:14px;font-weight:bold;color:#66ff88">${esc(guild.name)}</div>`
            + `<div style="font-size:11px;color:#888">Leader: ${esc(guild.leader)} | ${guild.members.length} members</div>`;
        guildPanel.appendChild(header);

        // My rank
        const me = guild.members.find(m => m.username === username);
        const myRank = me ? me.rank : 3;

        // Actions
        const actions = document.createElement("div");
        Object.assign(actions.style, { display: "flex", gap: "4px", marginBottom: "8px", flexWrap: "wrap" });

        if (myRank <= 2) {
            const invInput = document.createElement("input");
            invInput.placeholder = "Invite player...";
            Object.assign(invInput.style, {
                flex: "1", padding: "4px 8px", borderRadius: "4px",
                border: "1px solid #555", background: "#2a2a3e", color: "#e0e0e0", fontSize: "12px",
                minWidth: "120px",
            });
            invInput.addEventListener("keydown", (e) => e.stopPropagation());
            actions.appendChild(invInput);
            actions.appendChild(makeBtn("Invite", () => {
                const target = invInput.value.trim();
                if (!target || target === username) return;
                if (sendToPeer(target, {
                    type: "guild_invite",
                    guild_name: guild.name,
                    members: guild.members,
                })) {
                    saveChatMsg("system", "System", "Guild invite sent to " + target);
                } else {
                    saveChatMsg("system", "System", target + " is not connected. They must be online to invite.");
                }
                invInput.value = "";
            }));
        }
        actions.appendChild(makeBtn("Leave Guild", async () => {
            if (!confirm("Leave " + guild.name + "?")) return;
            // Notify guild peers
            const memberNames = guild.members.map(m => m.username).filter(n => n !== username);
            broadcastToPeers({ type: "guild_leave" }, memberNames);
            await saveGuild(null);
            await saveChatMsg("system", "System", "You left the guild.");
            renderGuild();
        }));
        guildPanel.appendChild(actions);

        // Members
        const RANK_LABELS = { 1: "Leader", 2: "Officer", 3: "Member" };
        const RANK_COLORS = { 1: "#ffcc44", 2: "#66ccff", 3: "#e0e0e0" };
        const isLeader = myRank === 1;

        guild.members.forEach(m => {
            const isOn = m.username === username || isPeerOnline(m.username);
            const row = document.createElement("div");
            Object.assign(row.style, {
                display: "flex", alignItems: "center", gap: "6px",
                padding: "3px 0", borderBottom: "1px solid #222",
            });
            const dot = isOn ? '<span style="color:#4f4">●</span>' : '<span style="color:#666">●</span>';
            const nameColor = isOn ? (RANK_COLORS[m.rank] || "#e0e0e0") : "#666";
            row.innerHTML = `${dot} <span style="color:${nameColor};flex:1">${esc(m.username)}</span>`
                + `<span style="color:#888;font-size:10px">${RANK_LABELS[m.rank] || ""}</span>`;

            if (isLeader && m.username !== username) {
                if (m.rank === 3) {
                    row.appendChild(makeBtn("Promote", async () => {
                        m.rank = 2;
                        await saveGuild(guild);
                        broadcastToPeers({ type: "guild_promote", target: m.username, rank: 2 },
                            guild.members.map(x => x.username).filter(n => n !== username));
                        renderGuild();
                    }));
                } else if (m.rank === 2) {
                    row.appendChild(makeBtn("Demote", async () => {
                        m.rank = 3;
                        await saveGuild(guild);
                        broadcastToPeers({ type: "guild_promote", target: m.username, rank: 3 },
                            guild.members.map(x => x.username).filter(n => n !== username));
                        renderGuild();
                    }));
                    row.appendChild(makeBtn("Transfer", async () => {
                        if (!confirm("Transfer leadership to " + m.username + "?")) return;
                        const oldMe = guild.members.find(x => x.username === username);
                        if (oldMe) oldMe.rank = 2;
                        m.rank = 1;
                        guild.leader = m.username;
                        await saveGuild(guild);
                        broadcastToPeers({ type: "guild_promote", target: m.username, rank: 1 },
                            guild.members.map(x => x.username).filter(n => n !== username));
                        renderGuild();
                    }));
                }
                row.appendChild(makeBtn("Kick", async () => {
                    guild.members = guild.members.filter(x => x.username !== m.username);
                    await saveGuild(guild);
                    broadcastToPeers({ type: "guild_kick", target: m.username },
                        guild.members.map(x => x.username).filter(n => n !== username));
                    sendToPeer(m.username, { type: "guild_kick", target: m.username });
                    renderGuild();
                }));
            }
            guildPanel.appendChild(row);
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────
    function makeBtn(label, onClick) {
        const btn = document.createElement("button");
        btn.textContent = label;
        Object.assign(btn.style, {
            padding: "2px 8px", borderRadius: "3px", border: "1px solid #555",
            background: "#2a2a3e", color: "#ccc", cursor: "pointer", fontSize: "11px",
            whiteSpace: "nowrap",
        });
        btn.addEventListener("click", onClick);
        return btn;
    }

    function esc(str) {
        const d = document.createElement("div");
        d.appendChild(document.createTextNode(str));
        return d.innerHTML;
    }

    // ── Init ───────────────────────────────────────────────────────
    async function init() {
        await openDB();
        buildUI();
        sigConnect();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
